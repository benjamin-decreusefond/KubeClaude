export type RunStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timeout'
  | 'skipped'
  | 'rate_limited';

export type TriggerType = 'cron' | 'interval' | 'session_reset' | 'weekly_reset' | 'quota_available';

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

export type CompletionCheck = 'marker' | 'judge' | 'always' | 'never';

export type PromptKind = 'scheduled' | 'chat' | 'goal';

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
  workingDir: string | null;
  permissionMode: PermissionMode;
  allowedTools: string[];
  disallowedTools: string[];
  appendSystemPrompt: string | null;
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
  lastFiredAt: string | null;
  nextFireAt: string | null;
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
  globalEnv: Record<string, string>;
  environmentBriefing: string;
  timezone: string;
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
  awaitingResume: number;
  quota: QuotaState;
  settings: Settings;
}

export interface Capabilities {
  tools: Array<{ name: string; available: boolean }>;
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
}

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  kind: 'alias' | 'model';
}
