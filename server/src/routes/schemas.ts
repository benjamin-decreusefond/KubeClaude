import { z } from 'zod';

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

export const permissionModeSchema = z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

export const promptCreateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(''),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
  model: z.string().max(120).nullable().default(null),
  workingDir: z.string().max(1024).nullable().default(null),
  permissionMode: permissionModeSchema.default('default'),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  appendSystemPrompt: z.string().nullable().default(null),
  maxTurns: z.number().int().positive().max(1000).nullable().default(null),
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
]);

export const triggerCreateSchema = z
  .object({
    type: triggerTypeSchema,
    enabled: z.boolean().default(true),
    cronExpression: z.string().max(200).nullable().default(null),
    timezone: z.string().max(80).default('UTC'),
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
  timezone: z.string().max(80).optional(),
  config: triggerConfigSchema.optional(),
});

export const settingsUpdateSchema = z.object({
  sessionWindowHours: z.number().min(0.5).max(168).optional(),
  weeklyWindowDays: z.number().min(1).max(60).optional(),
  sessionTokenBudget: z.number().int().min(0).optional(),
  weeklyTokenBudget: z.number().int().min(0).optional(),
  quotaGuardEnabled: z.boolean().optional(),
  quotaReservePct: z.number().min(0).max(90).optional(),
  defaultModel: z.string().max(120).nullable().optional(),
  globalEnv: envRecord.optional(),
  timezone: z.string().max(80).optional(),
  autoResumeEnabled: z.boolean().optional(),
  autoResumeDelayMinutes: z.number().int().min(0).max(1440).optional(),
});

export const runRequestSchema = z.object({
  /** Run something other than the stored prompt text, without editing the prompt. */
  promptText: z.string().min(1).optional(),
});
