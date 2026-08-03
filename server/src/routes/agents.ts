import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as agentStore from '../store/agents.js';

const idParams = z.object({ id: z.string().min(1) });

const configText = z.string().min(2).refine(
  (value) => {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
    } catch {
      return false;
    }
  },
  { message: 'Config must be a JSON object' },
);

const createSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    // The name becomes the key under which this agent appears in --agents.
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphens and underscores only'),
  description: z.string().max(1000).default(''),
  enabled: z.boolean().default(true),
  config: configText,
});

const updateSchema = createSchema.partial();

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/agents', async () => agentStore.listAgents());

  app.post('/api/agents', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid agent', details: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(agentStore.createAgent(parsed.data));
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'An agent with that name already exists' });
      }
      throw error;
    }
  });

  app.patch('/api/agents/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid agent', details: parsed.error.flatten() });
    }
    if (!agentStore.getAgent(id)) return reply.code(404).send({ error: 'Agent not found' });
    return agentStore.updateAgent(id, parsed.data);
  });

  app.delete('/api/agents/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!agentStore.deleteAgent(id)) {
      return reply.code(404).send({ error: 'Agent not found' });
    }
    return reply.code(204).send();
  });

  /** Show the exact --agents document a set of agents would produce. */
  app.post('/api/agents/preview', async (request, reply) => {
    const parsed = z
      .object({
        agentIds: z.array(z.string()).default([]),
        inlineConfig: z.string().nullable().default(null),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    return { document: agentStore.buildAgentsDocument(parsed.data.agentIds, parsed.data.inlineConfig) };
  });
}
