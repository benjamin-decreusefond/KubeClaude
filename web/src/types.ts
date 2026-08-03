export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped'
  | 'rate_limited'
  /** Stopped by a KubeClaude ceiling (turn cap or per-run token cap), not by a fault. */
  | 'capped';

export type TriggerType =
  | 'cron'
  | 'interval'
  | 'session_reset'
  | 'weekly_reset'
  | 'quota_available'
  | 'webhook';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

/** `--effort`; null anywhere means "leave it to the CLI". */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type CompletionCheck = 'marker' | 'judge' | 'always' | 'never';

export type PromptKind = 'scheduled' | 'chat' | 'goal';

export type AuthMethod = 'none' | 'forms' | 'basic' | 'external';

export type AuthRequirement = 'always' | 'local_bypass';

export interface AuthState {
  method: AuthMethod;
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  via: 'session' | 'basic' | 'proxy' | 'api-key' | 'local' | 'open' | null;
  /** Pinned by AUTH_METHOD in the environment, so the app cannot change it. */
  locked: boolean;
  /** Setting the first password requires presenting KUBECLAUDE_AUTH_TOKEN. */
  staticTokenRequired: boolean;
  local: boolean;
}

export interface AuthConfig {
  method: AuthMethod;
  requirement: AuthRequirement;
  externalUserHeader: string;
  username: string;
  configured: boolean;
  sessionDays: number;
  updatedAt: string;
  locked: boolean;
  hasApiKey: boolean;
  staticTokenConfigured: boolean;
  activeSessions: number;
}

export interface SetupInput {
  username: string;
  password: string;
  method: AuthMethod;
  requirement: AuthRequirement;
}

export type GoalStatus = 'active' | 'paused' | 'achieved' | 'abandoned';

export interface Objective {
  id: string;
  text: string;
  done: boolean;
  doneAt: string | null;
  note: string | null;
}

export interface Goal {
  id: string;
  promptId: string;
  name: string;
  description: string;
  objectives: Objective[];
  status: GoalStatus;
  cadenceMinutes: number;
  maxIterations: number;
  iteration: number;
  stopWhenAchieved: boolean;
  reviewModel: string | null;
  lastRunId: string | null;
  lastIterationAt: string | null;
  createdAt: string;
  updatedAt: string;
  progress: { done: number; total: number };
  prompt: Prompt | null;
  lastRun: Run | null;
}

export interface GoalIteration {
  id: string;
  goalId: string;
  seq: number;
  runId: string | null;
  createdAt: string;
  summary: string;
  nextStep: string | null;
  achieved: string[];
  source: 'report' | 'judge' | 'none';
  runStatus: string | null;
}

export interface GoalDetail extends Goal {
  iterations: GoalIteration[];
  runs: Run[];
}

export interface CreateGoalInput {
  name: string;
  description: string;
  objectives: string[];
  cadenceMinutes: number;
  maxIterations: number;
  stopWhenAchieved: boolean;
  reviewModel: string | null;
  keepSession: boolean;
  startNow: boolean;
  model: string | null;
  workingDir: string | null;
  repoUrl: string | null;
  repoRef: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  mcpServerIds: string[];
  timeoutSeconds: number;
  maxTurns: number | null;
}

export interface UpdateGoalInput {
  name?: string;
  description?: string;
  objectives?: Objective[];
  addObjectives?: string[];
  status?: GoalStatus;
  cadenceMinutes?: number;
  maxIterations?: number;
  stopWhenAchieved?: boolean;
  reviewModel?: string | null;
  keepSession?: boolean;
  model?: string | null;
  workingDir?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServerIds?: string[];
  timeoutSeconds?: number;
  maxTurns?: number | null;
}

export interface Prompt {
  id: string;
  kind: PromptKind;
  name: string;
  title: string | null;
  description: string;
  prompt: string;
  enabled: boolean;
  model: string | null;
  /** Models tried in order when the one above is overloaded (`--fallback-model`). */
  fallbackModel: string | null;
  /** Reasoning effort; null leaves the CLI's own default. */
  effort: Effort | null;
  /** Dollar ceiling for one run; null is off. */
  maxBudgetUsd: number | null;
  workingDir: string | null;
  /** Directories outside the working one the run may read and write. */
  addDirs: string[];
  /** Repository cloned into the working directory before each run, if any. */
  repoUrl: string | null;
  /** Branch, tag or commit to check out; null means the remote's default. */
  repoRef: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string | null;
  /** Replaces the CLI's own system prompt, where the one above only adds to it. */
  systemPrompt: string | null;
  /** Custom subagents, as the JSON object `--agents` takes. */
  agentsJson: string | null;
  /** Shared agents attached to this prompt. On a name collision, agentsJson wins. */
  agentIds: string[];
  /** Which built-in tools exist: null the CLI's full set, [] none, else only these. */
  builtinTools: string[] | null;
  /** Settings files the CLI reads: `none`, or a subset of user, project, local. */
  settingSources: string | null;
  maxTurns: number | null;
  timeoutSeconds: number;
  env: Record<string, string>;
  mcpConfig: string | null;
  mcpServerIds: string[];
  settingsJson: string | null;
  claudeMd: string | null;
  continueSession: boolean;
  lastSessionId: string | null;
  autoResume: boolean;
  maxAutoResumes: number;
  resumePrompt: string | null;
  completionCheck: CompletionCheck;
  completionMarker: string | null;
  judgeModel: string | null;
  createdAt: string;
  updatedAt: string;
  triggers?: Trigger[];
  lastRun?: Run | null;
  recentRuns?: Run[];
}

export interface TriggerConfig {
  intervalMinutes?: number;
  minSessionTokensAvailable?: number;
  minSessionPctAvailable?: number;
  minWeeklyPctAvailable?: number;
  minIntervalMinutes?: number;
  delayMinutes?: number;
}

export interface Trigger {
  id: string;
  promptId: string;
  type: TriggerType;
  enabled: boolean;
  cronExpression: string | null;
  timezone: string;
  config: TriggerConfig;
  /** webhook triggers only: the token embedded in the inbound URL. */
  webhookToken: string | null;
  lastFiredAt: string | null;
  nextFireAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  config: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
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
  model: string | null;
  modelUsage: Record<string, ModelUsage> | null;
  durationApiMs: number | null;
  serviceTier: string | null;
  resumeOfRunId: string | null;
  rootRunId: string;
  followUpText: string | null;
  resumeAttempt: number;
  rateLimitResetAt: string | null;
  autoResumePending: boolean;
  completed: boolean | null;
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
  kind: 'session' | 'weekly';
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

export type BillingMode = 'subscription' | 'api' | 'gateway' | 'none';

export type BudgetBasis = 'weighted' | 'input_output' | 'total';

export interface QuotaSlice {
  kind: 'session' | 'weekly';
  window: UsageWindow | null;
  used: number;
  basis: BudgetBasis;
  budget: number;
  remaining: number | null;
  remainingPct: number | null;
  resetsAt: string | null;
  /** `resetsAt` is Claude's own answer, not our five-hour arithmetic. */
  resetsAtObserved: boolean;
  fresh: boolean;
  exhausted: boolean;
}

export interface QuotaState {
  session: QuotaSlice;
  weekly: QuotaSlice;
  canRun: boolean;
  reason: string | null;
}

export interface Settings {
  sessionWindowHours: number;
  weeklyWindowDays: number;
  sessionTokenBudget: number;
  weeklyTokenBudget: number;
  budgetBasis: BudgetBasis;
  defaultMaxTurns: number;
  runTokenCap: number;
  quotaGuardEnabled: boolean;
  quotaReservePct: number;
  defaultModel: string | null;
  defaultFallbackModel: string | null;
  defaultEffort: Effort | null;
  globalEnv: Record<string, string>;
  environmentBriefing: string;
  timezone: string;
  gitUserName: string;
  gitUserEmail: string;
  autoResumeEnabled: boolean;
  autoResumeDelayMinutes: number;
}

export interface McpServer {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  config: string;
  createdAt: string;
  updatedAt: string;
}

export interface PeriodTotals {
  runs: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
  turns: number;
}

export interface DailyPoint {
  date: string;
  runs: number;
  totalTokens: number;
  costUsd: number;
}

export interface ModelBreakdown extends ModelUsage {
  model: string;
  totalTokens: number;
  runs: number;
}

export interface PromptBreakdown {
  promptId: string;
  promptName: string;
  runs: number;
  totalTokens: number;
  costUsd: number;
  failed: number;
}

export interface UpcomingRun {
  triggerId: string;
  promptId: string;
  promptName: string;
  type: string;
  nextFireAt: string;
  cronExpression: string | null;
  timezone: string;
}

export interface Dashboard {
  quota: QuotaState;
  totals: { session: PeriodTotals; week: PeriodTotals; month: PeriodTotals; allTime: PeriodTotals };
  daily: DailyPoint[];
  models: ModelBreakdown[];
  prompts: PromptBreakdown[];
  sessionWindows: UsageWindow[];
  weeklyWindows: UsageWindow[];
  upcoming: UpcomingRun[];
  recentRuns: Run[];
  awaitingResume: Run[];
}

export interface Status {
  version: string;
  claudeVersion: string | null;
  credentialsConfigured: boolean;
  billingMode: BillingMode;
  maxConcurrentRuns: number;
  activeRuns: number;
  queuedRuns: number;
  /** Those queued runs, by the kind of prompt that owns them. */
  queuedByKind: Record<string, number>;
  awaitingResume: number;
  /** Distinct faults in the error feed, so the sidebar can flag them. */
  errorCount: number;
  quota: QuotaState;
  settings: Settings;
}

export interface Capabilities {
  tools: Array<{ name: string; available: boolean }>;
  /** The headless browser, which lives off PATH under PLAYWRIGHT_BROWSERS_PATH. */
  browser: {
    available: boolean;
    executablePath: string | null;
    browsersPath: string | null;
    headlessShell: boolean;
  };
  git: { userName: string; userEmail: string; githubToken: boolean; tokenWithheld: boolean };
  credentials: { configured: boolean; mode: BillingMode; variables: string[]; ignored: string[] };
  forwardedEnvPrefixes: string[];
  forwardedEnvNames: string[];
  globalEnvNames: string[];
}

export interface ChatSummary {
  id: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastRun: Run | null;
  messageCount: number;
}

export interface ChatDetail extends Prompt {
  runs: Run[];
  /** True while a turn is in flight; the composer holds messages until it clears. */
  busy: boolean;
}

export interface StartChatInput {
  message: string;
  model?: string | null;
  permissionMode?: PermissionMode;
  workingDir?: string | null;
  repoUrl?: string | null;
  repoRef?: string | null;
  allowedTools?: string[];
  disallowedTools?: string[];
  mcpServerIds?: string[];
  env?: Record<string, string>;
  fromPromptId?: string;
}

export interface ToolPreset {
  id: string;
  label: string;
  description: string;
  allowedTools: string[];
  disallowedTools: string[];
  /** The permission mode the preset implies; applied along with the lists. */
  permissionMode: PermissionMode;
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  kind: 'alias' | 'model';
}

/** Where a recorded error came from. */
export type ErrorSource = 'server' | 'browser' | 'run';

/** One distinct fault, with how often it has happened since it first did. */
export interface AppError {
  id: string;
  source: ErrorSource;
  message: string;
  detail: string | null;
  context: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** A copy of the database taken before a migration. */
export interface DbBackup {
  file: string;
  bytes: number;
  takenAt: string;
}
