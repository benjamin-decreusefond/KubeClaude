import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeCredentials, config, forwardedEnvPrefixes } from '../config.js';
import { buildMcpDocument } from '../store/mcp.js';
import type { ModelUsage, Prompt, UsageTotals } from '../types.js';

export interface RunnerOptions {
  prompt: Prompt;
  runId: string;
  /** Effective prompt text (may differ from prompt.prompt for ad-hoc runs). */
  promptText: string;
  /** Claude session to continue instead of starting fresh. */
  resumeSessionId?: string | null;
  /** Extra system prompt text appended after the prompt's own. */
  appendSystemPrompt?: string;
  /** Extra env for this invocation only, merged last. */
  extraEnv?: Record<string, string>;
  globalEnv?: Record<string, string>;
  defaultModel?: string | null;
  onEvent: (kind: 'message' | 'stderr' | 'system', payload: unknown) => void;
  signal?: AbortSignal;
}

export interface RunnerResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string | null;
  resultText: string | null;
  isError: boolean;
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

  // Per-run scratch for the config files we hand to the CLI.
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), `kubeclaude-${options.runId.slice(0, 8)}-`));
  const cleanup = async () => {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  };

  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--input-format', 'text'];

  const model = prompt.model?.trim() || options.defaultModel?.trim();
  if (model) args.push('--model', model);

  // In marker mode the model has to know how to announce that it is done,
  // otherwise the completion check can never say "finished".
  const systemPromptParts = [prompt.appendSystemPrompt?.trim(), options.appendSystemPrompt?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  if (systemPromptParts.length > 0) {
    args.push('--append-system-prompt', systemPromptParts.join('\n\n'));
  }
  if (prompt.allowedTools.length > 0) args.push('--allowed-tools', prompt.allowedTools.join(','));
  if (prompt.disallowedTools.length > 0) args.push('--disallowed-tools', prompt.disallowedTools.join(','));
  if (prompt.permissionMode && prompt.permissionMode !== 'default') {
    args.push('--permission-mode', prompt.permissionMode);
  }
  if (prompt.maxTurns && prompt.maxTurns > 0) args.push('--max-turns', String(prompt.maxTurns));

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
    await fsp.writeFile(path.join(cwd, 'CLAUDE.md'), prompt.claudeMd, 'utf8');
  }

  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);

  return { args, cwd, env: buildEnv(options, home), cleanup };
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

/** Split a stream into complete lines, keeping the trailing partial line buffered. */
function lineSplitter(onLine: (line: string) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
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

    return {
      exitCode: code,
      signal,
      sessionId,
      resultText,
      isError: isError || (code !== 0 && code !== null),
      subtype,
      numTurns,
      usage,
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

  let out = '';
  child.stdout.on('data', (chunk: Buffer) => {
    if (out.length < 16 * 1024) out += chunk.toString('utf8');
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

    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString('utf8');
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
  for (const dir of [config.dataDir, config.workspacesDir, config.claudeHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
