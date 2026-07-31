import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Cron } from 'croner';
import { enqueueRun } from '../queue.js';
import * as triggerStore from '../store/triggers.js';
import { triggerRequirement, triggerUpdateSchema } from './schemas.js';

const idParams = z.object({ id: z.string().min(1) });

export async function triggerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/triggers', async () => triggerStore.listTriggers());

  app.patch('/api/triggers/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = triggerUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid trigger', details: parsed.error.flatten() });
    }
    const existing = triggerStore.getTrigger(id);
    if (!existing) return reply.code(404).send({ error: 'Trigger not found' });

    // The same rules the create path enforces, applied to what the trigger will
    // look like after the edit. Without this a trigger can be saved in a state
    // where it simply never fires, and nothing says so.
    const type = parsed.data.type ?? existing.type;
    const cronExpression =
      parsed.data.cronExpression === undefined ? existing.cronExpression : parsed.data.cronExpression;
    const config = parsed.data.config ?? existing.config;
    const problem = triggerRequirement(type, cronExpression, config);
    if (problem) return reply.code(400).send({ error: problem });
    // Changing the schedule invalidates the computed next fire time.
    return triggerStore.updateTrigger(id, { ...parsed.data, nextFireAt: null });
  });

  app.delete('/api/triggers/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!triggerStore.deleteTrigger(id)) return reply.code(404).send({ error: 'Trigger not found' });
    return reply.code(204).send();
  });

  app.post('/api/triggers/:id/fire', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const trigger = triggerStore.getTrigger(id);
    if (!trigger) return reply.code(404).send({ error: 'Trigger not found' });
    const run = enqueueRun({
      promptId: trigger.promptId,
      triggerId: trigger.id,
      triggerType: `manual:${trigger.type}`,
    });
    if (!run) return reply.code(409).send({ error: 'Could not queue the run' });
    return reply.code(202).send(run);
  });

  /** Preview the next occurrences of a cron expression, for the editor. */
  app.post('/api/cron/preview', async (request, reply) => {
    const body = z
      .object({ expression: z.string().min(1), timezone: z.string().default('UTC'), count: z.number().int().min(1).max(10).default(5) })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'Invalid request' });
    try {
      const cron = new Cron(body.data.expression, { timezone: body.data.timezone });
      const next: string[] = [];
      let cursor = new Date();
      for (let i = 0; i < body.data.count; i += 1) {
        const run = cron.nextRun(cursor);
        if (!run) break;
        next.push(run.toISOString());
        cursor = run;
      }
      return { valid: true, next };
    } catch (error) {
      return { valid: false, error: String(error instanceof Error ? error.message : error), next: [] };
    }
  });
}
