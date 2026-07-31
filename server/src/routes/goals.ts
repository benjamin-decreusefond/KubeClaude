import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { iterationReportInstruction, isAchieved, startIteration } from '../goals.js';
import { cancelRun, cancelRunsForPrompt } from '../queue.js';
import * as goalStore from '../store/goals.js';
import * as promptStore from '../store/prompts.js';
import * as runStore from '../store/runs.js';
import { goalCreateSchema, goalUpdateSchema } from './schemas.js';
import type { Goal, Prompt } from '../types.js';

const idParams = z.object({ id: z.string().min(1) });

/**
 * Prompt text of a goal's prompt. Every iteration overrides it with a composed
 * message, so this is only what you see when you look at the prompt itself.
 */
const PLACEHOLDER_PROMPT =
  'This prompt is driven by a goal. Each iteration is given the goal, the open objectives and ' +
  'the progress so far.';

/** Prompt names are unique; the goal name is only a starting point for one. */
function uniquePromptName(name: string): string {
  const base = `goal:${name}`.slice(0, 100);
  return promptStore.promptNameExists(base) ? `${base} ${randomUUID().slice(0, 6)}` : base;
}

function progressOf(goal: Goal) {
  const done = goal.objectives.filter((objective) => objective.done).length;
  return { done, total: goal.objectives.length };
}

function goalView(goal: Goal, prompt: Prompt | null) {
  return {
    ...goal,
    progress: progressOf(goal),
    prompt,
    lastRun: goal.lastRunId ? runStore.getRun(goal.lastRunId) : null,
  };
}

const PROMPT_FIELDS = [
  'model',
  'workingDir',
  'permissionMode',
  'allowedTools',
  'disallowedTools',
  'mcpServerIds',
  'mcpConfig',
  'settingsJson',
  'claudeMd',
  'env',
  'maxTurns',
  'timeoutSeconds',
] as const;

function promptPatchFrom(input: Record<string, unknown>): Partial<Prompt> {
  const patch: Record<string, unknown> = {};
  for (const field of PROMPT_FIELDS) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  return patch;
}

export async function goalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/goals', async () => {
    return goalStore.listGoals().map((goal) => goalView(goal, promptStore.getPrompt(goal.promptId)));
  });

  app.post('/api/goals', async (request, reply) => {
    const parsed = goalCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid goal', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    const prompt = promptStore.createPrompt({
      kind: 'goal',
      name: uniquePromptName(input.name),
      title: input.name,
      description: `Goal: ${input.name}`,
      prompt: PLACEHOLDER_PROMPT,
      enabled: true,
      model: input.model,
      workingDir: input.workingDir,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools,
      disallowedTools: input.disallowedTools,
      // How an iteration hands its state to the next one.
      appendSystemPrompt: iterationReportInstruction(),
      maxTurns: input.maxTurns,
      timeoutSeconds: input.timeoutSeconds,
      env: input.env,
      mcpConfig: input.mcpConfig,
      mcpServerIds: input.mcpServerIds,
      settingsJson: input.settingsJson,
      claudeMd: input.claudeMd,
      // The whole point: one session that keeps its context across iterations.
      continueSession: input.keepSession,
      // An iteration interrupted by the quota is worth finishing — the loop only
      // moves on once the work it started has actually landed.
      autoResume: true,
      maxAutoResumes: 3,
      resumePrompt:
        'The Claude usage limit interrupted this goal iteration. Continue exactly where you left ' +
        'off, without redoing finished work, and end with the iteration report.',
      completionCheck: 'always',
      completionMarker: null,
      judgeModel: null,
    });

    const goal = goalStore.createGoal({
      promptId: prompt.id,
      name: input.name,
      description: input.description,
      objectives: goalStore.makeObjectives(input.objectives),
      status: 'active',
      cadenceMinutes: input.cadenceMinutes,
      maxIterations: input.maxIterations,
      stopWhenAchieved: input.stopWhenAchieved,
      reviewModel: input.reviewModel,
    });

    // Otherwise the first iteration waits for the next scheduler tick.
    const started = input.startNow ? startIteration(goal, 'goal:manual') : null;
    const fresh = goalStore.getGoal(goal.id)!;
    return reply.code(201).send({ ...goalView(fresh, prompt), startedRun: started });
  });

  app.get('/api/goals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    return {
      ...goalView(goal, promptStore.getPrompt(goal.promptId)),
      iterations: goalStore.listIterations(goal.id),
      runs: runStore.listRuns({ promptId: goal.promptId, limit: 50 }),
    };
  });

  app.patch('/api/goals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = goalUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid goal', details: parsed.error.flatten() });
    }
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    const input = parsed.data;

    // Ticking the last objective by hand should end the goal the same way the
    // loop would, rather than leaving it to run one more pointless iteration.
    const objectives = input.objectives ?? goal.objectives;
    const withAdditions = input.addObjectives
      ? [...objectives, ...goalStore.makeObjectives(input.addObjectives, objectives)]
      : objectives;

    const patch: Partial<Goal> = {
      name: input.name,
      description: input.description,
      objectives: withAdditions,
      status: input.status,
      cadenceMinutes: input.cadenceMinutes,
      maxIterations: input.maxIterations,
      stopWhenAchieved: input.stopWhenAchieved,
      reviewModel: input.reviewModel,
    };
    let updated = goalStore.updateGoal(id, patch)!;

    if (updated.status === 'active' && updated.stopWhenAchieved && isAchieved(updated)) {
      updated = goalStore.updateGoal(id, { status: 'achieved' })!;
    }

    const promptPatch = promptPatchFrom(input);
    if (input.keepSession !== undefined) promptPatch.continueSession = input.keepSession;
    if (input.name !== undefined) promptPatch.title = input.name;
    if (Object.keys(promptPatch).length > 0) {
      promptStore.updatePrompt(goal.promptId, promptPatch);
    }

    return goalView(updated, promptStore.getPrompt(goal.promptId));
  });

  app.delete('/api/goals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    // The prompt exists only to serve the goal, and its runs go with it — but
    // an iteration that is running has to be stopped before any of that.
    cancelRunsForPrompt(goal.promptId);
    promptStore.deletePrompt(goal.promptId);
    goalStore.deleteGoal(id);
    return reply.code(204).send();
  });

  /** Resume the loop. A goal that already ended starts a new stretch of work. */
  app.post('/api/goals/:id/start', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    // Reaching its limit is what stopped it, so restarting has to lift the limit.
    const clearedLimit =
      goal.maxIterations > 0 && goal.iteration >= goal.maxIterations ? { maxIterations: 0 } : {};
    return goalView(
      goalStore.updateGoal(id, { status: 'active', ...clearedLimit })!,
      promptStore.getPrompt(goal.promptId),
    );
  });

  app.post('/api/goals/:id/pause', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    const updated = goalStore.updateGoal(id, { status: 'paused' })!;
    // Pausing while an iteration is in flight should stop that iteration too.
    const active = runStore
      .listRuns({ promptId: goal.promptId, limit: 5 })
      .find((run) => run.status === 'queued' || run.status === 'running');
    if (active) cancelRun(active.id);
    return goalView(updated, promptStore.getPrompt(goal.promptId));
  });

  /** Run an iteration right now, ignoring the cadence. */
  app.post('/api/goals/:id/iterate', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const goal = goalStore.getGoal(id);
    if (!goal) return reply.code(404).send({ error: 'Goal not found' });
    // Only the loop reads an iteration's report, and the loop leaves anything
    // that is not active alone — so an iteration started here would run, cost
    // tokens, and have its findings thrown away.
    if (goal.status !== 'active') {
      return reply.code(409).send({ error: 'Resume the goal before iterating it' });
    }
    const run = startIteration(goal, 'goal:manual');
    if (!run) {
      return reply.code(409).send({ error: 'An iteration is already running' });
    }
    return reply.code(202).send(run);
  });

  app.get('/api/goals/:id/iterations', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!goalStore.getGoal(id)) return reply.code(404).send({ error: 'Goal not found' });
    return { iterations: goalStore.listIterations(id) };
  });
}
