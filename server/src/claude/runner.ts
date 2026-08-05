import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { claudeCredentials, config, forwardedEnvPrefixes } from '../config.js';
import { describeCapabilities } from './environment.js';
import { DEFAULT_GIT_IDENTITY, prepareRepository, writeGitConfig, type GitIdentity } from './git.js';
import { buildAgentsDocument } from '../store/agents.js';
import { buildMcpDocument } from '../store/mcp.js';
import { weighTokens } from '../store/usage.js';
import type { BudgetBasis, Effort, ModelUsage, Prompt, UsageTotals } from '../types.js';

export interface RunnerOptions {
  prompt: Prompt;
  runId: string;
  /** Effective prompt text (may differ from prompt.prompt for ad-hoc runs). */
  promptText: string;
  /** Claude session to continue instead of starting fresh. */
  resumeSessionId?: string | null;
  /** Standing description of the environment, placed ahead of everything else. */
  environmentBriefing?: string;
  /** Extra system prompt text appended after the prompt's own. */
  appendSystemPrompt?: string;
  /** Extra env for this invocation only, merged last. */
  extraEnv?: Record<string, string>;
  globalEnv?: Record<string, string>;
  /** Who commits made during the run are authored by. */
  gitIdentity?: GitIdentity;
  defaultModel?: string | null;
  /** Fallback chain for a prompt that does not name its own. */
  defaultFallbackModel?: string | null;
  /** Effort for a prompt that does not pin one; null leaves the CLI's default. */
  defaultEffort?: Effort | null;
  /** Turn cap for a prompt that does not pin its own; 0 means uncapped. */
  defaultMaxTurns?: number;
  /** Kill the run once it has spent this much, weighed by `budgetBasis`; 0 disables. */
  runTokenCap?: number;
  budgetBasis?: BudgetBasis;
  onEvent: (kind: 'message' | 'stderr' | 'system', payload: unknown) => void;
  signal?: AbortSignal;
}

export interface RunnerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string | null;
  resultText: string | null;
  isError: boolean;
  /** The CLI stopped because it ran out of turns rather than out of work. */
  turnCapReached: boolean;
  subtype: string | null;
  numTurns: number | null;
  usage: UsageTotals;
  model: string | null;
  modelUsage: Record<string, ModelUsage> | null;
  durationApiMs: number | null;
  serviceTier: string | null;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  /** True when the run was killed for crossing the per-run token ceiling. */
  tokenCapExceeded: boolean;
  /** Spend at the moment it was stopped, weighed by the configured basis. */
  weighedTokens: number;
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 0,
  costUsd: 0,
};

/** Directory a prompt runs in: its own configured path, or a managed per-prompt workspace. */
export function workspaceFor(prompt: Prompt): string {
  return prompt.workingDir?.trim() || path.join(config.workspacesDir, prompt.id);
}

/**
 * Env for the child process. Nothing from the pod leaks in unless it is on the
 * allowlist, so a prompt cannot read unrelated cluster configuration.
 */
function buildEnv(options: RunnerOptions, home: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
    SHELL: process.env.SHELL ?? '/bin/bash',
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    // Long-running headless runs should never try to render progress UI.
    CI: '1',
    KUBECLAUDE_RUN_ID: options.runId,
    KUBECLAUDE_PROMPT_NAME: options.prompt.name,
  };

  // kubectl finds the in-cluster API server through these two, and reads the
  // ServiceAccount token from its mounted path. Without them it has no config
  // at all, which is why this is the switch for cluster access.
  if (config.exposeKubernetes) {
    for (const key of ['KUBERNETES_SERVICE_HOST', 'KUBERNETES_SERVICE_PORT', 'KUBERNETES_SERVICE_PORT_HTTPS']) {
      const value = process.env[key];
      if (value) base[key] = value;
    }
  }

  // `git` and `gh` read different variables; a deployment that set either one
  // meant both, so they are mirrored rather than left half-configured.
  if (config.exposeGitHubToken) {
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    if (token) {
      base.GITHUB_TOKEN = token;
      base.GH_TOKEN = token;
    }
  }

  // Belt and braces alongside the gitconfig: a repository that arrived with its
  // own committer configuration cannot leave a run unable to commit.
  const identity = options.gitIdentity ?? DEFAULT_GIT_IDENTITY;
  base.GIT_AUTHOR_NAME = identity.name;
  base.GIT_AUTHOR_EMAIL = identity.email;
  base.GIT_COMMITTER_NAME = identity.name;
  base.GIT_COMMITTER_EMAIL = identity.email;
  // Nobody is watching, so git must fail rather than wait for a password.
  base.GIT_TERMINAL_PROMPT = '0';

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (forwardedEnvPrefixes.some((prefix) => key.startsWith(prefix))) base[key] = value;
  }

  return {
    ...base,
    ...claudeCredentials(),
    ...(options.globalEnv ?? {}),
    ...options.prompt.env,
    ...(options.extraEnv ?? {}),
  };
}

interface PreparedInvocation {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

async function prepare(options: RunnerOptions): Promise<PreparedInvocation> {
  const { prompt } = options;
  const cwd = workspaceFor(prompt);
  await fsp.mkdir(cwd, { recursive: true });

  const home = config.claudeHome;
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });

  const env = buildEnv(options, home);

  // Identity and credentials first, so the clone below and everything the run
  // does afterwards are already authenticated and attributable.
  await writeGitConfig(home, options.gitIdentity ?? DEFAULT_GIT_IDENTITY);

  if (prompt.repoUrl?.trim()) {
    // Throwing here fails the run, which is the point: a prompt that names a
    // repository is about that repository, and running it against a stale or
    // missing checkout would do the wrong work convincingly.
    await prepareRepository({
      url: prompt.repoUrl.trim(),
      ref: prompt.repoRef,
      dir: cwd,
      env,
      onEvent: (payload) => options.onEvent('system', payload),
    });
  }

  // Per-run scratch for the config files we hand to the CLI.
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), `kubeclaude-${options.runId.slice(0, 8)}-`));
  const cleanup = async () => {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--input-format', 'text'];

  const model = prompt.model?.trim() || options.defaultModel?.trim();
  if (model) args.push('--model', model);

  // What to try when the chosen model is overloaded. Nobody is watching to
  // retry a scheduled run by hand, so a chain here is the difference between
  // the work happening on a smaller model and not happening at all.
  const fallbackModel = prompt.fallbackModel?.trim() || options.defaultFallbackModel?.trim();
  if (fallbackModel) args.push('--fallback-model', fallbackModel);

  const effort = prompt.effort ?? options.defaultEffort ?? null;
  if (effort) args.push('--effort', effort);

  // The CLI stops itself on this one and still reports what it spent, unlike
  // the token ceiling, which has to kill the process from outside.
  if (prompt.maxBudgetUsd && prompt.maxBudgetUsd > 0) {
    args.push('--max-budget-usd', String(prompt.maxBudgetUsd));
  }

  // Variadic on the CLI side: one flag, then every directory, terminated by the
  // next flag. The working directory is already granted, so these are the extra
  // ones — a second checkout, a shared cache — a prompt asked for.
  if (prompt.addDirs.length > 0) args.push('--add-dir', ...prompt.addDirs);

  // Order matters: the environment briefing establishes where the run is and
  // what it may do, before the prompt's own instructions narrow that down. The
  // last part is added by the caller — in marker mode it tells the model how to
  // announce that it finished, without which the completion check can never say
  // "done". Assembled here, but only pushed once everything is known.
  // The probe goes after the operator's briefing and before the prompt's own
  // instructions: the briefing says what this platform is for, the probe says
  // what this container can actually do, and the prompt says what to do with it.
  // The PATH half is cached for the process — an image swap arrives as a new
  // process, so re-running `which` before every run bought nothing and delayed
  // each start by eight spawns.
  const systemPromptParts = [
    options.environmentBriefing?.trim(),
    await describeCapabilities(),
    prompt.appendSystemPrompt?.trim(),
    options.appendSystemPrompt?.trim(),
  ].filter((part): part is string => Boolean(part));

  // Replaces the CLI's own system prompt. The parts assembled above are still
  // appended after it, so the briefing and the completion marker survive.
  if (prompt.systemPrompt?.trim()) args.push('--system-prompt', prompt.systemPrompt.trim());
  // Shared agents attached to this prompt, plus any inline --agents JSON,
  // merged the same way the MCP config below is: shared first, inline wins.
  const agentsDocument = buildAgentsDocument(prompt.agentIds, prompt.agentsJson);
  if (agentsDocument) args.push('--agents', agentsDocument);

  // Which built-in tools exist at all, as opposed to which may run unattended.
  // An empty list is meaningful — it hands the CLI no built-in tools — so this
  // turns on the flag for null-vs-empty rather than for length.
  if (prompt.builtinTools) args.push('--tools', prompt.builtinTools.join(','));

  // Left alone, the CLI reads the user, project and local settings files —
  // including the .claude/settings.json of whatever repository this run just
  // cloned. A prompt that would rather be handed only what KubeClaude gives it
  // says so here.
  if (prompt.settingSources) {
    args.push('--setting-sources', prompt.settingSources === 'none' ? '' : prompt.settingSources);
  }

  if (prompt.allowedTools.length > 0) args.push('--allowed-tools', prompt.allowedTools.join(','));
  if (prompt.disallowedTools.length > 0) args.push('--disallowed-tools', prompt.disallowedTools.join(','));
  if (prompt.permissionMode && prompt.permissionMode !== 'default') {
    args.push('--permission-mode', prompt.permissionMode);
  }
  // A prompt that pins its own turn cap wins, including an explicit 0 meaning
  // "no cap on purpose". Only a null falls through to the global default, which
  // is what stops an unattended run from looping until the window is gone.
  const maxTurns = prompt.maxTurns ?? options.defaultMaxTurns ?? 0;
  if (maxTurns > 0) args.push('--max-turns', String(maxTurns));

  // Shared MCP connections plus any inline config, written as one .mcp.json.
  // The servers themselves live elsewhere; this only tells Claude how to reach them.
  const mcpDocument = buildMcpDocument(prompt.mcpServerIds, prompt.mcpConfig);
  if (mcpDocument) {
    const file = path.join(scratch, 'mcp.json');
    await fsp.writeFile(file, mcpDocument, 'utf8');
    args.push('--mcp-config', file);
    // Without this the CLI would still require interactive approval of each server.
    args.push('--strict-mcp-config');
  }
  if (prompt.settingsJson?.trim()) {
    const file = path.join(scratch, 'settings.json');
    await fsp.writeFile(file, prompt.settingsJson, 'utf8');
    args.push('--settings', file);
  }
  if (prompt.claudeMd?.trim()) {
    const written = await writeManagedClaudeMd(cwd, prompt.claudeMd);
    if (!written) {
      // The working directory already has a CLAUDE.md somebody else owns —
      // usually a cloned repo's. Overwriting it would corrupt the checkout, so
      // deliver the same content through the system prompt instead.
      systemPromptParts.push(prompt.claudeMd.trim());
      options.onEvent('system', {
        kind: 'claude-md-preserved',
        path: path.join(cwd, 'CLAUDE.md'),
        reason:
          'The working directory already contains a CLAUDE.md that KubeClaude did not write. ' +
          'It was left untouched, and the prompt’s own CLAUDE.md went into the system prompt instead.',
      });
    }
  }

  if (systemPromptParts.length > 0) {
    args.push('--append-system-prompt', systemPromptParts.join('\n\n'));
  }

  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);

  return { args, cwd, env, cleanup };
}

/** Marks a CLAUDE.md as ours, so a later run knows it may be replaced. */
const MANAGED_MARKER = '<!-- managed by KubeClaude -->';

/**
 * Write the prompt's CLAUDE.md, but never over a file we did not write.
 * Returns false when an existing, unmanaged CLAUDE.md was left alone.
 */
async function writeManagedClaudeMd(cwd: string, content: string): Promise<boolean> {
  const target = path.join(cwd, 'CLAUDE.md');
  try {
    const existing = await fsp.readFile(target, 'utf8');
    if (!existing.startsWith(MANAGED_MARKER)) return false;
  } catch (error) {
    // Anything other than "not there" means we cannot tell; leave it alone.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  await fsp.writeFile(target, `${MANAGED_MARKER}\n${content}`, 'utf8');
  return true;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * `modelUsage` maps a model id to its own token counts, so a run that fell back
 * to a different model is still attributable.
 */
function readModelUsage(result: Record<string, unknown>): Record<string, ModelUsage> | null {
  const raw = result.modelUsage;
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, ModelUsage> = {};
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    out[model] = {
      inputTokens: num(entry.inputTokens ?? entry.input_tokens),
      outputTokens: num(entry.outputTokens ?? entry.output_tokens),
      cacheCreationTokens: num(entry.cacheCreationInputTokens ?? entry.cache_creation_input_tokens),
      cacheReadTokens: num(entry.cacheReadInputTokens ?? entry.cache_read_input_tokens),
      costUsd: num(entry.costUSD ?? entry.cost_usd ?? entry.costUsd),
    };
  }
  return Object.keys(out).length > 0 ? out : null;
}

function readUsage(result: Record<string, unknown>): UsageTotals {
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  const inputTokens = num(usage.input_tokens);
  const outputTokens = num(usage.output_tokens);
  const cacheCreationTokens = num(usage.cache_creation_input_tokens);
  const cacheReadTokens = num(usage.cache_read_input_tokens);
  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
    costUsd: num(result.total_cost_usd),
  };
}

/**
 * Split a stream into complete lines, keeping the trailing partial line buffered.
 *
 * Decoded through a `StringDecoder` rather than `chunk.toString('utf8')`. A
 * chunk boundary falls wherever the pipe happens to break, which is regularly
 * in the middle of a multi-byte character — and decoding each chunk on its own
 * turns the halves into replacement characters. Nothing then reports it: the
 * bytes are inside a JSON string, so the line still parses, and the corruption
 * is stored and rendered as though the model had written it. `café` arriving as
 * `caf<?><?>` is the whole failure. The decoder holds an incomplete sequence
 * back until the rest of it turns up.
 */
export function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf('\n');
    }
    // Guard against a pathological single-line payload eating all memory.
    if (buffer.length > 8 * 1024 * 1024) buffer = '';
  };
}

export async function runClaude(options: RunnerOptions): Promise<RunnerResult> {
  const { args, cwd, env, cleanup } = await prepare(options);

  options.onEvent('system', {
    kind: 'invocation',
    bin: config.claudeBin,
    // The prompt itself goes over stdin, so args are safe to show.
    args,
    cwd,
    resumeSessionId: options.resumeSessionId ?? null,
    envKeys: Object.keys(env).sort(),
  });

  const child = spawn(config.claudeBin, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let sessionId: string | null = options.resumeSessionId ?? null;
  let resultText: string | null = null;
  let isError = false;
  let subtype: string | null = null;
  let numTurns: number | null = null;
  let usage: UsageTotals = { ...EMPTY_USAGE };
  let model: string | null = null;
  let modelUsage: Record<string, ModelUsage> | null = null;
  let durationApiMs: number | null = null;
  let serviceTier: string | null = null;
  let stderr = '';
  let timedOut = false;
  let cancelled = false;
  let tokenCapExceeded = false;

  // Running total assembled from each turn's own usage. The `result` message is
  // authoritative once it arrives, but it only arrives if the run finishes — so
  // this is both the ceiling's input and the accounting fallback for a run we
  // killed before it could report.
  const live: UsageTotals = { ...EMPTY_USAGE };
  const basis = options.budgetBasis ?? 'weighted';
  const cap = options.runTokenCap ?? 0;

  const onTurnUsage = (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return;
    const usageRecord = raw as Record<string, unknown>;
    live.inputTokens += num(usageRecord.input_tokens);
    live.outputTokens += num(usageRecord.output_tokens);
    live.cacheCreationTokens += num(usageRecord.cache_creation_input_tokens);
    live.cacheReadTokens += num(usageRecord.cache_read_input_tokens);
    live.totalTokens =
      live.inputTokens + live.outputTokens + live.cacheCreationTokens + live.cacheReadTokens;

    if (cap <= 0 || tokenCapExceeded) return;
    const weighed = weighTokens(live, basis);
    if (weighed < cap) return;

    tokenCapExceeded = true;
    options.onEvent('system', {
      kind: 'token-cap-exceeded',
      cap,
      basis,
      weighedTokens: weighed,
      rawTokens: live.totalTokens,
      message:
        `This run crossed the per-run ceiling of ${cap} tokens (${weighed} spent, weighed as ` +
        `"${basis}") and was stopped. Raise the ceiling in Settings, narrow the prompt, or cap ` +
        'its turns if it is looping.',
    });
    terminate(child);
  };

  const onStdoutLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.onEvent('stderr', { text: line });
      return;
    }
    options.onEvent('message', message);

    const record = message as Record<string, unknown>;
    if (typeof record.session_id === 'string') sessionId = record.session_id;
    if (record.type === 'system' && record.subtype === 'init' && typeof record.model === 'string') {
      model = record.model;
    }
    if (record.type === 'assistant') {
      // Each assistant message carries the usage of the API call that produced
      // it, so summing them tracks spend as it happens rather than after.
      const inner = record.message as Record<string, unknown> | undefined;
      onTurnUsage(inner?.usage ?? record.usage);
    }
    if (record.type === 'result') {
      isError = record.is_error === true;
      subtype = typeof record.subtype === 'string' ? record.subtype : null;
      resultText = typeof record.result === 'string' ? record.result : null;
      numTurns = typeof record.num_turns === 'number' ? record.num_turns : null;
      usage = readUsage(record);
      modelUsage = readModelUsage(record);
      durationApiMs = typeof record.duration_api_ms === 'number' ? record.duration_api_ms : null;
      const tier = (record.usage as Record<string, unknown> | undefined)?.service_tier;
      if (typeof tier === 'string') serviceTier = tier;
      // A run that fell back mid-flight reports the model it ended on here.
      if (!model && modelUsage) model = Object.keys(modelUsage)[0] ?? null;
    }
  };

  child.stdout.on('data', lineSplitter(onStdoutLine));

  const onStderrLine = (line: string) => {
    if (stderr.length < 64 * 1024) stderr += `${line}\n`;
    options.onEvent('stderr', { text: line });
  };
  child.stderr.on('data', lineSplitter(onStderrLine));

  child.stdin.on('error', () => {
    /* the CLI may exit before reading stdin; nothing useful to do */
  });
  child.stdin.end(options.promptText);

  const timeoutMs = Math.max(30, options.prompt.timeoutSeconds) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    terminate(child);
  }, timeoutMs);

  const onAbort = () => {
    cancelled = true;
    terminate(child);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const { code, signal } = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
      },
    );

    // A run we killed — on the ceiling, the timeout or a cancel — never emits a
    // `result`, so its spend would otherwise vanish from the quota windows. The
    // turn-by-turn total is the only record of what it actually cost.
    const finalUsage = usage.totalTokens > 0 ? usage : live;

    return {
      exitCode: code,
      signal,
      sessionId,
      resultText,
      isError: isError || tokenCapExceeded || (code !== 0 && code !== null),
      // `error_max_turns` is the CLI saying it was cut off, not that the task
      // was impossible — a different thing to be told, and a different thing to
      // do about it.
      turnCapReached: subtype === 'error_max_turns',
      subtype,
      numTurns,
      usage: finalUsage,
      tokenCapExceeded,
      weighedTokens: weighTokens(finalUsage, basis),
      model,
      modelUsage,
      durationApiMs,
      serviceTier,
      stderr: stderr.trim(),
      timedOut,
      cancelled,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    await cleanup();
  }
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 10_000).unref();
}

export interface OneShotOptions {
  promptText: string;
  model?: string;
  timeoutSeconds?: number;
}

/**
 * A single, tool-free Claude call used for internal questions such as "was this
 * task finished?". It shares the run credentials but nothing else: no workspace,
 * no MCP connections, no prompt env.
 */
export async function runOneShot(options: OneShotOptions): Promise<string | null> {
  const home = config.claudeHome;
  await fsp.mkdir(path.join(home, '.claude'), { recursive: true });

  const args = ['--print', '--output-format', 'text', '--max-turns', '1'];
  if (options.model) args.push('--model', options.model);

  const child = spawn(config.claudeBin, args, {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: home,
      TZ: process.env.TZ ?? 'UTC',
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      CI: '1',
      ...claudeCredentials(),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Same reason as `lineSplitter`: a chunk can end mid-character, and this
  // output is a judge's verdict that gets JSON-parsed.
  const decoder = new StringDecoder('utf8');
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    if (out.length < 16 * 1024) out += decoder.write(chunk);
  });
  child.stderr.resume();
  child.stdin.on('error', () => undefined);
  child.stdin.end(options.promptText);

  const timer = setTimeout(() => terminate(child), Math.max(15, options.timeoutSeconds ?? 120) * 1000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return code === 0 ? out.trim() : null;
  } finally {
    clearTimeout(timer);
  }
}

let versionCache: { value: string | null; at: number } | null = null;
const VERSION_TTL_MS = 60_000;

/**
 * Best-effort probe so the UI can say the CLI is missing. Cached, bounded by a
 * timeout, and with stdin closed — a wedged binary must not wedge /api/status.
 */
export async function claudeVersion(): Promise<string | null> {
  if (versionCache && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value;

  const value = await new Promise<string | null>((resolve) => {
    let settled = false;
    const done = (result: string | null) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.claudeBin, ['--version'], {
        env: { PATH: process.env.PATH ?? '', HOME: config.claudeHome },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      done(null);
      return;
    }

    const decoder = new StringDecoder('utf8');
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4096) out += decoder.write(chunk);
    });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code === 0 ? out.trim() : null));

    setTimeout(() => {
      terminate(child);
      done(null);
    }, 5_000).unref();
  });

  versionCache = { value, at: Date.now() };
  return value;
}

export function ensureDirectories(): void {
  const dirs = [config.dataDir, config.workspacesDir, config.claudeHome];
  // A volume mounted over HOME hides whatever the image created there, so make
  // sure it exists at startup — git and gh need somewhere to write.
  if (process.env.HOME) dirs.push(process.env.HOME);
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
