import { z } from 'zod';
import type { TriggerConfig, TriggerType } from '../types.js';

const envRecord = z.record(z.string(), z.string());

const jsonText = (label: string) =>
  z
    .string()
    .refine(
      (value) => {
        if (value.trim() === '') return true;
        try {
          JSON.parse(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: `${label} must be valid JSON` },
    )
    .nullable();

export const permissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'plan',
  // The CLI's own classifier decides per tool call: ordinary work proceeds, and
  // what it flags needs an approval nobody is here to give, so it is denied.
  'auto',
  'bypassPermissions',
]);

export const effortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * One model alias or id, or a comma-separated chain of them, for
 * `--fallback-model`. Restricted to the characters a model name can contain, so
 * it cannot arrive at the CLI as something other than a model.
 */
export const fallbackModelSchema = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*$/, 'One model, or several separated by commas')
  .nullable();

/**
 * Extra directories a run may touch. Absolute only: a relative path would be
 * resolved against a working directory that differs per prompt, and a leading
 * dash would arrive at the CLI as a flag.
 */
export const addDirsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(1024)
      .refine((value) => value.startsWith('/') && !value.includes('\n'), {
        message: 'Use an absolute path',
      }),
  )
  .max(20);

/**
 * A remote git can be reached at. Anything else — a local path, a `file://`,
 * something with a shell metacharacter in it — is refused: this string is handed
 * to `git clone`, and a prompt naming a path on the pod's disk is either a
 * mistake or an attempt to read something it should not.
 */
export const repoUrlSchema = z
  .string()
  .max(500)
  .refine(
    (value) => /^https:\/\/[^\s]+$/.test(value) || /^(ssh:\/\/)?git@[^\s]+:[^\s]+$/.test(value),
    { message: 'Use an https:// or git@host:owner/repo URL' },
  )
  .nullable();

/** A branch, tag or commit. Git's own rules, minus the ways to smuggle a flag. */
export const repoRefSchema = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9._/-]+$/, 'Use a branch, tag or commit')
  .refine((value) => !value.startsWith('-') && !value.includes('..'), { message: 'Not a valid ref' })
  .nullable();

/**
 * Which settings files the CLI reads. `none` is spelled out rather than left as
 * an empty string so that "read nothing" and "not configured" stay two visibly
 * different values everywhere they travel.
 */
export const settingSourcesSchema = z
  .string()
  .max(40)
  .refine(
    (value) =>
      value === 'none' ||
      (value.length > 0 &&
        value.split(',').every((part) => ['user', 'project', 'local'].includes(part.trim()))),
    { message: 'Use none, or a comma-separated subset of user, project, local' },
  )
  .nullable();

/**
 * A prompt's turn cap, where null and 0 are two different answers: null inherits
 * `defaultMaxTurns`, and 0 opts out of any cap on purpose — which is what the
 * runner reads (`prompt.maxTurns ?? defaultMaxTurns`, so a 0 does not fall
 * through) and what the editor tells you to type. Rejecting 0 here made that
 * documented escape hatch unreachable through the API.
 */
export const maxTurnsSchema = z.number().int().min(0).max(1000).nullable().default(null);

/** Built-in tool names, as the CLI spells them: Bash, Edit, Read, WebFetch… */
export const builtinToolsSchema = z
  .array(z.string().min(1).max(80).regex(/^[A-Za-z0-9_]+$/, 'Use a built-in tool name'))
  .max(60)
  .nullable();

export const promptCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  model: z.string().max(120).nullable().default(null),
  fallbackModel: fallbackModelSchema.default(null),
  effort: effortSchema.nullable().default(null),
  maxBudgetUsd: z.number().min(0).max(10_000).nullable().default(null),
  workingDir: z.string().max(1024).nullable().default(null),
  addDirs: addDirsSchema.default([]),
  repoUrl: repoUrlSchema.default(null),
  repoRef: repoRefSchema.default(null),
  permissionMode: permissionModeSchema.default('default'),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  appendSystemPrompt: z.string().nullable().default(null),
  systemPrompt: z.string().max(100_000).nullable().default(null),
  agentsJson: jsonText('Agents definition').default(null),
  agentIds: z.array(z.string()).default([]),
  builtinTools: builtinToolsSchema.default(null),
  settingSources: settingSourcesSchema.default(null),
  maxTurns: maxTurnsSchema,
  timeoutSeconds: z.number().int().min(30).max(86_400).default(1800),
  env: envRecord.default({}),
  mcpConfig: jsonText('MCP config').default(null),
  mcpServerIds: z.array(z.string()).default([]),
  settingsJson: jsonText('Claude settings').default(null),
  claudeMd: z.string().nullable().default(null),
  continueSession: z.boolean().default(false),
  autoResume: z.boolean().default(true),
  maxAutoResumes: z.number().int().min(0).max(100).default(5),
  resumePrompt: z.string().nullable().default(null),
  completionCheck: z.enum(['marker', 'judge', 'always', 'never']).default('marker'),
  completionMarker: z
    .string()
    .max(120)
    // It has to survive being matched on a line of its own, so keep it plain.
    .regex(/^[A-Z0-9_\-:]*$/i, 'Use letters, digits, hyphens, underscores and colons only')
    .nullable()
    .default(null),
  judgeModel: z.string().max(120).nullable().default(null),
});

export const promptUpdateSchema = promptCreateSchema.partial().extend({
  lastSessionId: z.string().nullable().optional(),
});

/**
 * A timezone the platform actually knows. Storing one it does not means the
 * trigger throws on every scheduler tick and never fires — a silent failure
 * that only shows up as a line in the log nobody is reading.
 */
export const timezoneSchema = z
  .string()
  .max(80)
  .refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { message: 'Unknown timezone. Use an IANA name such as Europe/Paris.' },
  );

export const triggerConfigSchema = z.object({
  intervalMinutes: z.number().int().positive().max(100_000).optional(),
  minSessionTokensAvailable: z.number().int().min(0).optional(),
  minSessionPctAvailable: z.number().min(0).max(100).optional(),
  minWeeklyPctAvailable: z.number().min(0).max(100).optional(),
  minIntervalMinutes: z.number().int().min(0).max(100_000).optional(),
  delayMinutes: z.number().int().min(0).max(10_000).optional(),
});

export const triggerTypeSchema = z.enum([
  'cron',
  'interval',
  'session_reset',
  'weekly_reset',
  'quota_available',
  'webhook',
]);

export const triggerCreateSchema = z
  .object({
    type: triggerTypeSchema,
    enabled: z.boolean().default(true),
    cronExpression: z.string().max(200).nullable().default(null),
    timezone: timezoneSchema.default('UTC'),
    config: triggerConfigSchema.default({}),
  })
  .refine((value) => value.type !== 'cron' || Boolean(value.cronExpression?.trim()), {
    message: 'cron triggers need a cron expression',
    path: ['cronExpression'],
  })
  .refine((value) => value.type !== 'interval' || Boolean(value.config.intervalMinutes), {
    message: 'interval triggers need config.intervalMinutes',
    path: ['config', 'intervalMinutes'],
  });

export const triggerUpdateSchema = z.object({
  type: triggerTypeSchema.optional(),
  enabled: z.boolean().optional(),
  cronExpression: z.string().max(200).nullable().optional(),
  timezone: timezoneSchema.optional(),
  config: triggerConfigSchema.optional(),
});

/**
 * What a trigger of this type needs before it can fire at all. An edit merges
 * with what is already stored, so this cannot live in the schema the way the
 * create rules do — but the answer has to be the same either way, or a trigger
 * can be edited into a state it could never have been created in.
 */
export function triggerRequirement(
  type: TriggerType,
  cronExpression: string | null,
  config: TriggerConfig,
): string | null {
  if (type === 'cron' && !cronExpression?.trim()) return 'cron triggers need a cron expression';
  if (type === 'interval' && !config.intervalMinutes) return 'interval triggers need config.intervalMinutes';
  return null;
}

export const settingsUpdateSchema = z.object({
  sessionWindowHours: z.number().min(0.5).max(168).optional(),
  weeklyWindowDays: z.number().min(1).max(60).optional(),
  sessionTokenBudget: z.number().int().min(0).optional(),
  weeklyTokenBudget: z.number().int().min(0).optional(),
  budgetBasis: z.enum(['weighted', 'input_output', 'total']).optional(),
  defaultMaxTurns: z.number().int().min(0).max(1000).optional(),
  runTokenCap: z.number().int().min(0).optional(),
  quotaGuardEnabled: z.boolean().optional(),
  quotaReservePct: z.number().min(0).max(90).optional(),
  defaultModel: z.string().max(120).nullable().optional(),
  defaultFallbackModel: fallbackModelSchema.optional(),
  defaultEffort: effortSchema.nullable().optional(),
  globalEnv: envRecord.optional(),
  environmentBriefing: z.string().max(50_000).optional(),
  timezone: z.string().max(80).optional(),
  gitUserName: z.string().min(1).max(120).optional(),
  // Git's own rule, which is looser than an internet address: our default is
  // `kubeclaude@localhost`, and a host that has no dot in it is perfectly valid.
  gitUserEmail: z
    .string()
    .min(3)
    .max(200)
    .regex(/^[^\s@]+@[^\s@]+$/, 'Use an address of the form name@host')
    .optional(),
  autoResumeEnabled: z.boolean().optional(),
  autoResumeDelayMinutes: z.number().int().min(0).max(1440).optional(),
  notifyWebhookUrl: z.union([z.literal(''), z.string().url().max(2000)]).optional(),
  notifyOnSuccess: z.boolean().optional(),
  notifyOnFailure: z.boolean().optional(),
});

/**
 * Configuration a goal shares with a prompt. A goal owns its prompt, so these
 * are edited through the goal rather than in the prompt editor.
 */
const goalPromptSchema = z.object({
  model: z.string().max(120).nullable().default(null),
  fallbackModel: fallbackModelSchema.default(null),
  effort: effortSchema.nullable().default(null),
  maxBudgetUsd: z.number().min(0).max(10_000).nullable().default(null),
  workingDir: z.string().max(1024).nullable().default(null),
  addDirs: addDirsSchema.default([]),
  repoUrl: repoUrlSchema.default(null),
  repoRef: repoRefSchema.default(null),
  permissionMode: permissionModeSchema.default('bypassPermissions'),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  mcpServerIds: z.array(z.string()).default([]),
  mcpConfig: jsonText('MCP config').default(null),
  settingsJson: jsonText('Claude settings').default(null),
  claudeMd: z.string().nullable().default(null),
  env: envRecord.default({}),
  systemPrompt: z.string().max(100_000).nullable().default(null),
  agentsJson: jsonText('Agents definition').default(null),
  agentIds: z.array(z.string()).default([]),
  builtinTools: builtinToolsSchema.default(null),
  settingSources: settingSourcesSchema.default(null),
  maxTurns: maxTurnsSchema,
  timeoutSeconds: z.number().int().min(30).max(86_400).default(3600),
});

export const goalCreateSchema = goalPromptSchema.extend({
  name: z.string().min(1).max(120),
  description: z.string().max(20_000).default(''),
  /** One objective per entry; blank entries are dropped. */
  objectives: z.array(z.string().max(2000)).max(100).default([]),
  /**
   * Mark every objective above as standing: a mission the goal keeps working at
   * rather than a box any one iteration can tick.
   */
  continuousObjectives: z.boolean().default(false),
  cadenceMinutes: z.number().int().min(0).max(100_000).default(30),
  maxIterations: z.number().int().min(0).max(10_000).default(0),
  stopWhenAchieved: z.boolean().default(true),
  reviewModel: z.string().max(120).nullable().default(null),
  /** Keep one Claude session across iterations, so context carries forward. */
  keepSession: z.boolean().default(true),
  /** Start the first iteration immediately instead of waiting for the loop. */
  startNow: z.boolean().default(true),
});

export const objectiveSchema = z.object({
  id: z.string().min(1).max(40),
  text: z.string().min(1).max(2000),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  note: z.string().max(2000).nullable(),
  /** Absent on goals stored before standing objectives existed. */
  continuous: z.boolean().default(false),
});

export const goalUpdateSchema = goalPromptSchema.partial().extend({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(20_000).optional(),
  objectives: z.array(objectiveSchema).max(100).optional(),
  /** Extra objectives, appended with fresh ids. */
  addObjectives: z.array(z.string().max(2000)).max(100).optional(),
  /** Whether those extra objectives are standing ones. */
  addObjectivesContinuous: z.boolean().optional(),
  status: z.enum(['active', 'paused', 'achieved', 'abandoned']).optional(),
  cadenceMinutes: z.number().int().min(0).max(100_000).optional(),
  maxIterations: z.number().int().min(0).max(10_000).optional(),
  stopWhenAchieved: z.boolean().optional(),
  reviewModel: z.string().max(120).nullable().optional(),
  keepSession: z.boolean().optional(),
});

export const runRequestSchema = z.object({
  /** Run something other than the stored prompt text, without editing the prompt. */
  promptText: z.string().min(1).optional(),
});
