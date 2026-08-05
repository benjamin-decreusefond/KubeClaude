import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

/**
 * The git environment a run wakes up in, driven against a real repository on
 * disk. Nothing here is mocked: the point of this layer is that `git` itself is
 * satisfied — an identity it accepts, a checkout it can push from — and a stub
 * would only prove that our idea of git is self-consistent.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-git-'));
process.env.DATA_DIR = tmpDir;

const { writeGitConfig, prepareRepository, redact, GitError, DEFAULT_GIT_IDENTITY } = await import(
  '../src/claude/git.js'
);

/** A remote to clone from: a bare repository with one commit on `main`. */
const remote = path.join(tmpDir, 'remote.git');
const seed = path.join(tmpDir, 'seed');
const home = path.join(tmpDir, 'home');

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      GIT_AUTHOR_NAME: 'Seed',
      GIT_AUTHOR_EMAIL: 'seed@example.com',
      GIT_COMMITTER_NAME: 'Seed',
      GIT_COMMITTER_EMAIL: 'seed@example.com',
    },
  });
}

/** Git as a run invokes it: HOME and nothing else — no identity in the env. */
function asRun(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home } });
}

function commit(message: string, file: string, contents: string): void {
  fs.writeFileSync(path.join(seed, file), contents);
  run('git', ['add', '.'], seed);
  run('git', ['commit', '-m', message], seed);
  run('git', ['push', 'origin', 'HEAD'], seed);
}

const env = { PATH: process.env.PATH ?? '', HOME: home };
const events: Array<Record<string, unknown>> = [];
const onEvent = (payload: Record<string, unknown>) => events.push(payload);

before(async () => {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(seed, { recursive: true });
  await writeGitConfig(home, DEFAULT_GIT_IDENTITY);

  run('git', ['init', '--bare', '--initial-branch=main', remote], tmpDir);
  run('git', ['init', '--initial-branch=main'], seed);
  run('git', ['remote', 'add', 'origin', remote], seed);
  commit('first', 'README.md', '# one\n');
  run('git', ['branch', 'topic'], seed);
  run('git', ['push', 'origin', 'topic'], seed);
});

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('the gitconfig gives a run an identity and a way to authenticate', async () => {
  const file = await writeGitConfig(home, { name: 'KubeClaude Test', email: 'test@example.com' });
  const contents = fs.readFileSync(file, 'utf8');

  assert.match(contents, /name = KubeClaude Test/);
  assert.match(contents, /email = test@example\.com/);
  // The credential helper reads the token when git asks rather than storing it,
  // so a rotated token needs no file edited and a leaked backup holds nothing.
  assert.match(contents, /credential "https:\/\/github\.com"/);
  assert.match(contents, /GITHUB_TOKEN/);
  assert.ok(!contents.includes('password=gh'), 'no literal credential belongs in this file');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // And git agrees it is a valid file, which a hand-written config easily is not.
  const identity = run('git', ['config', '--global', 'user.email'], tmpDir).trim();
  assert.equal(identity, 'test@example.com');

  await writeGitConfig(home, DEFAULT_GIT_IDENTITY);
});

test('a run in a repository can commit without configuring anything first', async () => {
  const dir = path.join(tmpDir, 'committer');
  await prepareRepository({ url: remote, ref: 'main', dir, env, onEvent });

  fs.writeFileSync(path.join(dir, 'from-the-run.txt'), 'written by a run\n');
  // No user.name, no user.email, no credential setup — exactly what a prompt
  // that was just told "fix the bug and push" would do.
  asRun(['add', '.'], dir);
  asRun(['commit', '-m', 'from the run'], dir);

  const author = asRun(['log', '-1', '--format=%an <%ae>'], dir).trim();
  assert.equal(author, `${DEFAULT_GIT_IDENTITY.name} <${DEFAULT_GIT_IDENTITY.email}>`);
});

test('the first run clones and every run after it catches up', async () => {
  const dir = path.join(tmpDir, 'workspace');

  const first = await prepareRepository({ url: remote, ref: 'main', dir, env, onEvent });
  assert.equal(first.cloned, true);
  assert.equal(first.ref, 'main');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# one\n');

  // Somebody pushes while the workspace sits there between runs.
  commit('second', 'README.md', '# two\n');

  const second = await prepareRepository({ url: remote, ref: 'main', dir, env, onEvent });
  assert.equal(second.cloned, false, 'the checkout is reused, not cloned again');
  assert.notEqual(second.head, first.head);
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# two\n');
});

test('whatever the last run left behind, the next one starts clean', async () => {
  const dir = path.join(tmpDir, 'workspace');

  // A run that edited a tracked file and wandered onto another branch, which is
  // what an interrupted one looks like.
  fs.writeFileSync(path.join(dir, 'README.md'), 'half-finished edit\n');
  run('git', ['checkout', '-b', 'leftover'], dir);

  // And the part `reset --hard` cannot undo, because git is not tracking it:
  // whatever the run wrote and never committed. Left behind it outlives every
  // run after this one, and the next typecheck or test sweep picks up a source
  // file that is in no commit and nobody can find in the repository.
  fs.writeFileSync(path.join(dir, 'scratch.ts'), 'export const leftover = 1\n');
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'notes/thinking.md'), 'half a thought\n');

  const state = await prepareRepository({ url: remote, ref: 'main', dir, env, onEvent });

  assert.equal(state.ref, 'main');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# two\n');
  assert.equal(fs.existsSync(path.join(dir, 'scratch.ts')), false, 'an untracked file must not outlive the run');
  assert.equal(fs.existsSync(path.join(dir, 'notes')), false, 'nor a directory of them');
  assert.equal(run('git', ['status', '--porcelain'], dir).trim(), '');
});

test('what the repository ignores on purpose is not treated as debris', async () => {
  const dir = path.join(tmpDir, 'workspace');

  // `node_modules` and build caches are kept out of the repository deliberately
  // and cost minutes to rebuild. Cleaning is meant to remove what a run
  // dropped, not to make every run reinstall its dependencies.
  fs.mkdirSync(path.join(dir, 'node_modules/left-pad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules/left-pad/index.js'), 'module.exports = 1\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  run('git', ['add', '.gitignore'], dir);
  run('git', ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-m', 'ignore node_modules'], dir);
  run('git', ['push', 'origin', 'HEAD:main'], dir);

  await prepareRepository({ url: remote, ref: 'main', dir, env, onEvent });

  assert.equal(fs.existsSync(path.join(dir, 'node_modules/left-pad/index.js')), true);
});

test('a ref that is not the default is honoured', async () => {
  const dir = path.join(tmpDir, 'on-topic');
  const state = await prepareRepository({ url: remote, ref: 'topic', dir, env, onEvent });

  assert.equal(state.ref, 'topic');
  assert.equal(run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim(), 'topic');
  // `topic` was branched before the second commit and never moved.
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# one\n');
});

test('no ref means whatever the remote calls its default', async () => {
  const dir = path.join(tmpDir, 'default-branch');
  const state = await prepareRepository({ url: remote, ref: null, dir, env, onEvent });

  assert.equal(state.ref, 'main');
  assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), '# two\n');
});

test('a repository that cannot be reached fails the run and says why', async () => {
  const dir = path.join(tmpDir, 'nowhere');
  await assert.rejects(
    () => prepareRepository({ url: path.join(tmpDir, 'not-a-repo.git'), ref: null, dir, env, onEvent }),
    (error: unknown) => {
      assert.ok(error instanceof GitError);
      assert.match(error.message, /clone failed/);
      return true;
    },
  );

  // The failure is on the run's log too, not only in the exception.
  const failure = events.filter((event) => event.ok === false).pop();
  assert.equal(failure?.kind, 'repository');
  assert.equal(failure?.step, 'clone');
});

test('a ref that does not exist fails rather than running against the wrong code', async () => {
  const dir = path.join(tmpDir, 'bad-ref');
  await assert.rejects(() => prepareRepository({ url: remote, ref: 'no-such-branch', dir, env, onEvent }), GitError);
});

test('credentials never reach the run log', () => {
  const text = 'fatal: could not read from https://x-access-token:ghp_secretvalue@github.com/owner/repo.git';
  const masked = redact(text, { GITHUB_TOKEN: 'ghp_secretvalue' });

  assert.ok(!masked.includes('ghp_secretvalue'), masked);
  assert.match(masked, /github\.com\/owner\/repo\.git/);
});
