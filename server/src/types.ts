export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped'
  /** Stopped because the Claude quota ran out; eligible for automatic resume. */
  | 'rate_limited';

export type TriggerType =
  | 'cron'
  | 'interval'
  | 'session_reset'
  | 'weekly_reset'
  | 'quota_available';

export type WindowKind = 'session' | 'weekly';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/**
 * How KubeClaude decides whether a run that stopped on a quota limit had already
 * finished its task — a finished task must not be resumed, an unfinished one must.
 */
export type CompletionCheck =
  /** The prompt is told to print a sentinel line when done; we look for it. */
  | 'marker'
  /** Ask a cheap model to judge the transcript. */
  | 'judge'
  /** Treat every interrupted run as unfinished. */
  | 'always'
  /** Never resume this prompt automatically. */
  | 'never';

export interface Prompt {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  model: string | null;
  workingDir: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string | null;
  maxTurns: number | null;
  timeoutSeconds: number;
  env: Record<string, string>;
  /** Inline `.mcp.json` fragment, merged after the selected shared servers. */
  mcpConfig: string | null;
  /** Shared MCP servers attached to this prompt. */
  mcpServerIds: string[];
  settingsJson: string | null;
  claudeMd: string | null;
  continueSession: boolean;
  lastSessionId: string | null;
  /** Re-queue the run (resuming its session) once the quota comes back. */
  autoResume: boolean;
  /** Give up after this many automatic resumes of the same session. */
  maxAutoResumes: number;
  /** Message sent when resuming an interrupted session; a default is used when empty. */
  resumePrompt: string | null;
  /** How to tell a finished task from an interrupted one. */
  completionCheck: CompletionCheck;
  /** Sentinel line for `marker` mode; a default is used when empty. */
  completionMarker: string | null;
  /** Model used by `judge` mode; a cheap one is plenty. */
  judgeModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Trigger {
  id: string;
  promptId: string;
  type: TriggerType;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  config: TriggerConfig;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerConfig {
  /** interval triggers: minutes between runs. */
  intervalMinutes?: number;
  /** quota_available: fire once at least this many tokens are free in the 5h window. */
  minSessionTokensAvailable?: number;
  /** quota_available: fire once at least this share (0-100) of the 5h budget is free. */
  minSessionPctAvailable?: number;
  /** quota_available: also require this share (0-100) of the weekly budget to be free. */
  minWeeklyPctAvailable?: number;
  /** Never fire more often than this, whatever the trigger type says. */
  minIntervalMinutes?: number;
  /** *_reset triggers: wait this long after the new window opens before firing. */
  delayMinutes?: number;
}

export interface Run {
  id: string;
  promptId: string;
  promptName: string;
  triggerId: string | null;
  triggerType: string;
  status: RunStatus;
  promptText: string;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  sessionId: string | null;
  exitCode: number | null;
  error: string | null;
  numTurns: number | null;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  resultText: string | null;
  /** Model reported by the CLI's init message. */
  model: string | null;
  /** Per-model token breakdown, when the CLI reports one. */
  modelUsage: Record<string, ModelUsage> | null;
  /** Time spent waiting on the Anthropic API, as opposed to local tool work. */
  durationApiMs: number | null;
  serviceTier: string | null;
  /** The run this one continues: an auto-resume, a manual resume, or a follow-up. */
  resumeOfRunId: string | null;
  /** First run of the conversation this run belongs to; equals `id` for a root run. */
  rootRunId: string;
  /** The follow-up message, when a human pushed the conversation further. */
  followUpText: string | null;
  /** How many times this chain of runs has already been auto-resumed. */
  resumeAttempt: number;
  /** When the quota that stopped this run is expected back (from the CLI, if it says). */
  rateLimitResetAt: string | null;
  /** Set on a rate-limited run until the scheduler has resumed it. */
  autoResumePending: boolean;
  /** Whether the task was already finished when the run stopped; null if unchecked. */
  completed: boolean | null;
  /** How that was decided, for display in the UI. */
  completionReason: string | null;
}

export interface RunEvent {
  runId: string;
  seq: number;
  ts: string;
  kind: 'message' | 'stderr' | 'system';
  payload: unknown;
}

export interface UsageWindow {
  id: string;
  kind: WindowKind;
  startedAt: string;
  endsAt: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  runCount: number;
}

export interface Settings {
  /** Length of a Claude session window, in hours. */
  sessionWindowHours: number;
  /** Length of the weekly window, in days. */
  weeklyWindowDays: number;
  /** Token allowance per session window; 0 means unknown/unlimited. */
  sessionTokenBudget: number;
  /** Token allowance per weekly window; 0 means unknown/unlimited. */
  weeklyTokenBudget: number;
  /** Refuse to start runs once a budget is exhausted. */
  quotaGuardEnabled: boolean;
  /** Keep this share (0-100) of each budget unspent when the guard is on. */
  quotaReservePct: number;
  /** Default model when a prompt does not pin one. */
  defaultModel: string | null;
  /** Env injected into every run, before the prompt's own env. */
  globalEnv: Record<string, string>;
  /**
   * Standing description of the environment, prepended to every run's system
   * prompt. This is where a scheduled run learns that it has a cluster, a
   * GitHub token, and a GitOps loop to work through. Empty disables it.
   */
  environmentBriefing: string;
  /** Timezone used for new cron triggers and for UI date rendering. */
  timezone: string;
  /** Master switch for resuming rate-limited runs when the quota returns. */
  autoResumeEnabled: boolean;
  /** Grace period after a quota reset before a resume is attempted. */
  autoResumeDelayMinutes: number;
}

/**
 * A reference to an MCP server that already runs somewhere else — in the cluster,
 * on a remote host, or as a stdio command. KubeClaude never deploys or hosts the
 * server; it only stores how to reach it and hands that to Claude at run time.
 */
export interface McpServer {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** The entry as it appears under `mcpServers` in a `.mcp.json` file. */
  config: string;
  createdAt: string;
  updatedAt: string;
}

/** Per-model slice of a run's usage, as reported in `modelUsage`. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Usage numbers reported by the Claude CLI `result` message. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
}
