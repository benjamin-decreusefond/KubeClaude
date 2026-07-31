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

  /**
   * Optional static token, accepted as a bearer token or `X-Api-Key`. It exists
   * for deployments that configure everything through the environment; the API
   * key generated at setup does the same job for everyone else.
   */
  authToken: process.env.KUBECLAUDE_AUTH_TOKEN ?? '',
  /**
   * Pin the login method — `none`, `forms`, `basic` or `external`. Set it and
   * the UI shows the choice as locked, so a cluster that puts this behind an
   * oauth2-proxy cannot have that turned off from inside the app.
   */
  authMethod: process.env.AUTH_METHOD ?? '',
  /**
   * Let runs talk to the Kubernetes API with the pod's ServiceAccount.
   * kubectl builds its in-cluster config from KUBERNETES_SERVICE_HOST/PORT, so
   * withholding those is what actually turns cluster access off — the token
   * file alone is useless without them. Set to false for a run that should be
   * unable to reach the cluster at all.
   */
  exposeKubernetes: bool('EXPOSE_KUBERNETES', true),

  /** Serve the built SPA from the server. */
  serveWeb: bool('SERVE_WEB', true),
  webDir: process.env.WEB_DIR ?? path.resolve(process.cwd(), 'web/dist'),
} as const;

/** How a run is paying for itself. */
export type BillingMode = 'subscription' | 'api' | 'gateway' | 'none';

/**
 * Credentials handed to every Claude invocation.
 *
 * These are not interchangeable: a subscription token draws on the plan's
 * rolling allowance, an API key bills per token against Console credit. Passing
 * both would leave which one pays up to the CLI, so exactly one is forwarded —
 * the subscription token wins, because that is the one the quota windows,
 * quota-aware triggers and auto-resume are all built around. A gateway is its
 * own thing and takes precedence over both, since a base URL is only ever set
 * deliberately.
 */
export function claudeCredentials(): Record<string, string> {
  const env: Record<string, string> = {};

  if (process.env.ANTHROPIC_BASE_URL) {
    env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
    if (process.env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
    if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    return env;
  }

  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    return env;
  }

  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.ANTHROPIC_AUTH_TOKEN) env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

export function billingMode(): BillingMode {
  const env = claudeCredentials();
  if (env.ANTHROPIC_BASE_URL) return 'gateway';
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription';
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return 'api';
  return 'none';
}

/**
 * Credentials that are set in the pod but deliberately not forwarded, so the UI
 * can say "you also set an API key, it is being ignored" rather than leaving you
 * to wonder which one is paying.
 */
export function shadowedCredentials(): string[] {
  const forwarded = new Set(Object.keys(claudeCredentials()));
  return ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].filter(
    (name) => process.env[name] && !forwarded.has(name),
  );
}

export function hasCredentials(): boolean {
  return billingMode() !== 'none';
}

/**
 * Env vars from the pod that are forwarded into Claude runs. Everything else is
 * dropped so a prompt cannot read unrelated cluster configuration by accident.
 */
export const forwardedEnvPrefixes = (process.env.FORWARD_ENV_PREFIXES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
