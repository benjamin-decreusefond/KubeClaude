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

/**
 * `scheduled` prompts are the ones you define once and let triggers fire.
 * `chat` prompts are conversations you start directly and keep talking to;
 * they run through exactly the same machinery.
 * `goal` prompts are owned by a goal and driven by its loop, never by a trigger.
 */
export type PromptKind = 'scheduled' | 'chat' | 'goal';

export interface Prompt {
  id: string;
  kind: PromptKind;
  name: string;
  /** Display name for a chat, derived from its first message. */
  title: string | null;
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

/**
 * Which tokens count against a budget. Agentic runs re-read a large cached
 * prefix on every turn, so counting cache reads at face value makes any
 * sanely-sized budget read as exhausted after a single run.
 */
export type BudgetBasis = 'weighted' | 'input_output' | 'total';

/**
 * How a person proves who they are. Machine clients are separate: an API key
 * always works, whatever this says, so automation does not break when the
 * login method changes.
 */
export type AuthMethod =
  /** Nobody is asked anything. Only sane behind something else that gates access. */
  | 'none'
  /** A login page and a session cookie. */
  | 'forms'
  /** The browser's own credentials dialog, sent on every request. */
  | 'basic'
  /**
   * A reverse proxy in front (oauth2-proxy, Authelia, Cloudflare Access) has
   * already authenticated the request. KubeClaude trusts it and reads the user
   * name out of a header.
   */
  | 'external';

/** Whether the local network is treated as already trusted. */
export type AuthRequirement = 'always' | 'local_bypass';

export interface AuthConfig {
  method: AuthMethod;
  requirement: AuthRequirement;
  /** Header carrying the user name in `external` mode. */
  externalUserHeader: string;
  /** Set once, at setup; changing it does not invalidate anything else. */
  username: string;
  /** True once a password has been set, so the UI knows setup is behind it. */
  configured: boolean;
  /** How long a forms session stays valid. */
  sessionDays: number;
  updatedAt: string;
}

/**
 * What the login screen is allowed to know before anybody has authenticated:
 * enough to render the right form, and nothing about the instance itself.
 */
export interface AuthState {
  method: AuthMethod;
  /** Nobody has set a password yet, so the first thing to do is set one. */
  setupRequired: boolean;
  /** The caller is already authenticated. */
  authenticated: boolean;
  /** Who they are, when that is known. */
  username: string | null;
  /** How they got in, for the UI to explain itself. */
  via: 'session' | 'basic' | 'proxy' | 'api-key' | 'local' | 'open' | null;
  /** The method is pinned by an environment variable and cannot be changed here. */
  locked: boolean;
  /** This request came from a private address, so the local bypass could apply. */
  local: boolean;
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
  /** How raw token counts are converted into budget spend. */
  budgetBasis: BudgetBasis;
  /**
   * Turn cap applied to any prompt that does not set its own. Spend grows
   * superlinearly with turns — every turn re-sends the whole prefix — so an
   * uncapped run that goes in circles can eat a window on its own. 0 disables.
   */
  defaultMaxTurns: number;
  /**
   * Hard ceiling on what one run may spend, weighed by `budgetBasis`. The run is
   * killed on the turn that crosses it. 0 disables, which is the default: this
   * stops a run mid-task, so it is a deliberate choice rather than a surprise.
   */
  runTokenCap: number;
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

/**
 * A goal runs by itself until its objectives are met. `active` is the working
 * state; `paused` is a human holding it; `achieved` and `abandoned` are ends —
 * one because everything was ticked off, the other because it ran out of
 * iterations or its session became unusable.
 */
export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

/** One thing the goal has to accomplish, ticked off as the work lands. */
export interface Objective {
  /** Short and stable (`o1`, `o2`, …) so the model can name it back to us. */
  id: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  /** How it came to be done: the model's own words, or "marked by hand". */
  note: string | null;
}

/**
 * A standing objective set with a session behind it. Where a prompt answers
 * "run this now", a goal answers "keep working on this until it is true":
 * every iteration resumes the same Claude session, reads what the last one
 * achieved, does the next most valuable thing, and reports back.
 */
export interface Goal {
  id: string;
  /** The prompt that carries the configuration and the session; kind `goal`. */
  promptId: string;
  name: string;
  /** The mission: what "done" looks like, in prose. */
  description: string;
  objectives: Objective[];
  status: GoalStatus;
  /** Minimum wait between the end of one iteration and the start of the next. */
  cadenceMinutes: number;
  /** Give up after this many iterations; 0 means keep going indefinitely. */
  maxIterations: number;
  /** How many iterations have been started so far. */
  iteration: number;
  /**
   * Stop at `achieved` once every objective is ticked. Turning this off is what
   * makes a goal open-ended: it keeps iterating and improving past the checklist.
   */
  stopWhenAchieved: boolean;
  /**
   * Model asked to review an iteration whose report could not be parsed. Null
   * means never spend a second call: an unparseable report just carries forward.
   */
  reviewModel: string | null;
  /** The iteration currently running, or the last one that ran. */
  lastRunId: string | null;
  lastIterationAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** What one iteration achieved, as recorded once its run finished. */
export interface GoalIteration {
  id: string;
  goalId: string;
  seq: number;
  runId: string | null;
  createdAt: string;
  /** What the iteration did, in its own words. */
  summary: string;
  /** What it says should happen next; fed into the following iteration. */
  nextStep: string | null;
  /** Objectives this iteration ticked off. */
  achieved: string[];
  /** How the summary was obtained: the run's own report, a judge, or neither. */
  source: 'report' | 'judge' | 'none';
  /** Status of the run behind it, so a stalled loop is visible in the log. */
  runStatus: string | null;
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

/** Where a recorded error came from. */
export type ErrorSource = 'server' | 'browser' | 'run';

/** One distinct fault, with how often it has happened since it first did. */
export interface AppError {
  id: string;
  source: ErrorSource;
  message: string;
  /** Stack or body, clipped. */
  detail: string | null;
  /** Where it happened: a request path, a browser route, a run id. */
  context: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}
