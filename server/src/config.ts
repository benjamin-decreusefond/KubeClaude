import path from 'node:path';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

const dataDir = process.env.DATA_DIR ?? path.resolve(process.cwd(), 'data');

export const config = {
  port: int('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',

  dataDir,
  dbPath: process.env.DB_PATH ?? path.join(dataDir, 'kubeclaude.db'),
  /** Root under which per-prompt workspaces are created when a prompt has no explicit working dir. */
  workspacesDir: process.env.WORKSPACES_DIR ?? path.join(dataDir, 'workspaces'),
  /** HOME for the spawned Claude CLI, so it can persist its own config/credentials cache. */
  claudeHome: process.env.CLAUDE_HOME ?? path.join(dataDir, 'claude-home'),

  claudeBin: process.env.CLAUDE_BIN ?? 'claude',

  /** How often the scheduler evaluates triggers. */
  schedulerIntervalMs: int('SCHEDULER_INTERVAL_MS', 20_000),
  /** How many Claude runs may execute at the same time. */
  maxConcurrentRuns: int('MAX_CONCURRENT_RUNS', 1),
  /** Events kept in the DB per run; older ones are trimmed. */
  maxEventsPerRun: int('MAX_EVENTS_PER_RUN', 5_000),
  /** Runs older than this are pruned on startup and daily. 0 disables pruning. */
  runRetentionDays: int('RUN_RETENTION_DAYS', 30),

  /** Optional bearer token protecting the API and UI. */
  authToken: process.env.KUBECLAUDE_AUTH_TOKEN ?? '',
  /** Serve the built SPA from the server. */
  serveWeb: bool('SERVE_WEB', true),
  webDir: process.env.WEB_DIR ?? path.resolve(process.cwd(), 'web/dist'),
} as const;

/**
 * Credentials handed to every Claude invocation. Either an API key or a
 * subscription OAuth token works; the OAuth token is what makes the 5h/weekly
 * session windows meaningful.
 */
export function claudeCredentials(): Record<string, string> {
  const env: Record<string, string> = {};
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  }
  if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  if (process.env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function hasCredentials(): boolean {
  return Object.keys(claudeCredentials()).some((key) =>
    ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'].includes(key),
  );
}

/**
 * Env vars from the pod that are forwarded into Claude runs. Everything else is
 * dropped so a prompt cannot read unrelated cluster configuration by accident.
 */
export const forwardedEnvPrefixes = (process.env.FORWARD_ENV_PREFIXES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
