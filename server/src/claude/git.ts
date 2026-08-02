import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/**
 * The git environment a run wakes up in.
 *
 * Everything here used to be the prompt's problem: set an identity or the first
 * commit fails with "Please tell me who you are", wire a credential helper or
 * `git push` over HTTPS asks for a password nobody is there to type, remember
 * whether the repository was already cloned last time. That is four ways for a
 * run to get most of the way through a job and stop, and it is the same four
 * every time — so it belongs here rather than in every prompt.
 */

export interface GitIdentity {
  name: string;
  email: string;
}

export const DEFAULT_GIT_IDENTITY: GitIdentity = {
  name: 'KubeClaude',
  email: 'kubeclaude@localhost',
};

/** How long any one git operation may take before it is abandoned. */
const GIT_TIMEOUT_MS = 300_000;

/**
 * Write the gitconfig every run shares.
 *
 * The credential helper is a shell function rather than a stored token: it
 * reads the environment at the moment git asks, so nothing secret is written to
 * disk, and a rotated token takes effect on the next run without anyone editing
 * a file.
 */
export async function writeGitConfig(home: string, identity: GitIdentity): Promise<string> {
  const file = path.join(home, '.gitconfig');
  const contents = `# Written by KubeClaude on every run. Edits here are overwritten.
[user]
\tname = ${identity.name}
\temail = ${identity.email}
[init]
\tdefaultBranch = main
[advice]
\tdetachedHead = false
[safe]
\tdirectory = *
[pull]
\trebase = false
[credential "https://github.com"]
\thelper = "!f() { test \\"$1\\" = get && echo username=x-access-token && echo password=\\"\${GITHUB_TOKEN:-$GH_TOKEN}\\"; }; f"
`;
  await fsp.mkdir(home, { recursive: true });
  await fsp.writeFile(file, contents, { mode: 0o600 });
  return file;
}

export interface GitResult {
  ok: boolean;
  /** Combined stdout and stderr, trimmed — git says the useful part on stderr. */
  output: string;
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      env: {
        ...env,
        // Nothing is watching, so a prompt for a password must fail rather than
        // hang until the run times out.
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
      },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${shell.stdout ?? ''}${shell.stderr ?? ''}`.trim() || (shell.message ?? 'git failed') };
  }
}

/**
 * Secrets reach git through the environment, and git echoes the URL it was
 * given in its errors. Anything that looks like credentials in a URL is masked
 * before the output is stored on a run.
 */
export function redact(text: string, env: NodeJS.ProcessEnv): string {
  let out = text.replace(/\/\/[^\s/@]*:[^\s/@]*@/g, '//***:***@');
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const value = env[key];
    if (value && value.length > 6) out = out.split(value).join('***');
  }
  return out;
}

export interface PrepareRepositoryOptions {
  url: string;
  /** Branch, tag or commit to check out. Empty means the remote's default. */
  ref: string | null;
  /** Where the checkout lives — the run's working directory. */
  dir: string;
  env: NodeJS.ProcessEnv;
  onEvent: (payload: Record<string, unknown>) => void;
}

export interface RepositoryState {
  cloned: boolean;
  ref: string | null;
  head: string | null;
}

export class GitError extends Error {}

/**
 * Put the working directory on the requested commit, whatever state it was in.
 *
 * First run clones. Every run after that fetches and hard-resets onto the
 * remote — deliberately, not a merge: the checkout is a scratch copy of the
 * remote, and a run that left a conflicted merge or a half-finished rebase
 * behind must not poison the next one. Anything worth keeping was pushed.
 */
export async function prepareRepository(options: PrepareRepositoryOptions): Promise<RepositoryState> {
  const { url, ref, dir, env } = options;
  const fail = (step: string, result: GitResult): never => {
    const message = `${step} failed: ${redact(result.output, env)}`;
    options.onEvent({ kind: 'repository', step, ok: false, message });
    throw new GitError(message);
  };

  await fsp.mkdir(dir, { recursive: true });
  const fresh = !fs.existsSync(path.join(dir, '.git'));

  if (fresh) {
    // Cloning into a directory that already holds files (a previous run's
    // scratch, say) fails, so clone in and let git populate it.
    const clone = await git(['clone', url, '.'], dir, env);
    if (!clone.ok) fail('clone', clone);
  } else {
    const remote = await git(['remote', 'set-url', 'origin', url], dir, env);
    if (!remote.ok) fail('remote', remote);
  }

  const fetch = await git(['fetch', '--prune', 'origin'], dir, env);
  if (!fetch.ok) fail('fetch', fetch);

  const target = ref?.trim() || (await defaultBranch(dir, env));
  if (target) {
    const checkout = await git(['checkout', '--force', target], dir, env);
    if (!checkout.ok) fail('checkout', checkout);

    // A branch follows the remote; a tag or a commit is already exactly where
    // it should be and has no upstream to reset onto.
    const isBranch = (await git(['rev-parse', '--verify', `refs/remotes/origin/${target}`], dir, env)).ok;
    if (isBranch) {
      const reset = await git(['reset', '--hard', `origin/${target}`], dir, env);
      if (!reset.ok) fail('reset', reset);
    }
  }

  const head = await git(['rev-parse', 'HEAD'], dir, env);
  const state: RepositoryState = {
    cloned: fresh,
    ref: target,
    head: head.ok ? head.output.split('\n')[0]! : null,
  };

  logger.info({ dir, ref: state.ref, head: state.head, cloned: state.cloned }, 'repository ready');
  options.onEvent({ kind: 'repository', step: fresh ? 'clone' : 'update', ok: true, ...state, url: redact(url, env) });
  return state;
}

/** What the remote calls its default branch, when the prompt did not say. */
async function defaultBranch(dir: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const head = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir, env);
  if (head.ok) return head.output.split('\n')[0]?.replace(/^origin\//, '') ?? null;

  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], dir, env);
  return current.ok ? (current.output.split('\n')[0] ?? null) : null;
}
