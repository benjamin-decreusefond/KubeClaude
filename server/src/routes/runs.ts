import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelRun, enqueueRun } from '../queue.js';
import * as runStore from '../store/runs.js';
import { getPrompt } from '../store/prompts.js';
import { DEFAULT_RESUME_PROMPT, continuationTriggerType } from '../scheduler.js';

const idParams = z.object({ id: z.string().min(1) });

const followUpSchema = z.object({ message: z.string().min(1).max(100_000) });

const listQuery = z.object({
  promptId: z.string().optional(),
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout', 'skipped', 'rate_limited'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/runs', async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const { promptId, status, limit, offset } = parsed.data;
    return {
      items: runStore.listRuns({ promptId, status: status, limit, offset }),
      total: runStore.countRuns({ promptId, status: status }),
    };
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const run = runStore.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    return run;
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    if (!runStore.getRun(id)) return reply.code(404).send({ error: 'Run not found' });
    return { events: runStore.listEvents(id, query.data.after) };
  });

  /** Every run in the conversation this run belongs to. */
  app.get('/api/runs/:id/thread', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!runStore.getRun(id)) return reply.code(404).send({ error: 'Run not found' });
    return { runs: runStore.listThread(id) };
  });

  /**
   * Push the conversation further: resume the run's Claude session with a new
   * message, so the model keeps its full context instead of starting over.
   */
  app.post('/api/runs/:id/follow-up', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = followUpSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const run = runStore.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (!run.sessionId) {
      return reply
        .code(409)
        .send({ error: 'This run has no Claude session to continue; start a new run instead' });
    }
    if (run.status === 'queued' || run.status === 'running') {
      return reply.code(409).send({ error: 'Wait for the run to finish before following up' });
    }

    const queued = enqueueRun({
      promptId: run.promptId,
      triggerId: null,
      triggerType: 'follow_up',
      promptText: parsed.data.message,
      followUpText: parsed.data.message,
      resumeOfRunId: run.id,
      // A human follow-up does not count against the automatic resume budget.
      resumeAttempt: run.resumeAttempt,
      sessionId: run.sessionId,
    });
    if (!queued) return reply.code(409).send({ error: 'Could not queue the follow-up' });
    return reply.code(202).send(queued);
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const run = runStore.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    if (!cancelRun(id)) {
      return reply.code(409).send({ error: `A ${run.status} run cannot be cancelled` });
    }
    return runStore.getRun(id);
  });

  /** Manually resume a run that stopped on a quota limit, without waiting for the sweep. */
  app.post('/api/runs/:id/resume', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const run = runStore.getRun(id);
    if (!run) return reply.code(404).send({ error: 'Run not found' });
    const prompt = getPrompt(run.promptId);
    if (!prompt) return reply.code(404).send({ error: 'Prompt not found' });
    if (!run.sessionId && run.status === 'succeeded') {
      return reply.code(409).send({ error: 'Nothing to resume' });
    }

    runStore.updateRun(run.id, { autoResumePending: false });
    const resumed = enqueueRun({
      promptId: run.promptId,
      triggerId: run.triggerId,
      triggerType: continuationTriggerType('manual_resume', run.triggerType),
      promptText: run.sessionId
        ? prompt.resumePrompt?.trim() || DEFAULT_RESUME_PROMPT
        : run.promptText,
      resumeOfRunId: run.id,
      resumeAttempt: run.resumeAttempt + 1,
      sessionId: run.sessionId,
    });
    if (!resumed) return reply.code(409).send({ error: 'Could not queue the resume' });
    return reply.code(202).send(resumed);
  });
}
