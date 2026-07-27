import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import * as mcpStore from '../store/mcp.js';

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
    // The name becomes a key in .mcp.json and part of tool names like mcp__<name>__<tool>.
    .regex(/^[A-Za-z0-9_-]+$/, 'Use letters, digits, hyphens and underscores only'),
  description: z.string().max(1000).default(''),
  enabled: z.boolean().default(true),
  config: configText,
});

const updateSchema = createSchema.partial();

export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/mcp-servers', async () => mcpStore.listMcpServers());

  app.post('/api/mcp-servers', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MCP connection', details: parsed.error.flatten() });
    }
    try {
      return reply.code(201).send(mcpStore.createMcpServer(parsed.data));
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'An MCP connection with that name already exists' });
      }
      throw error;
    }
  });

  app.patch('/api/mcp-servers/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid MCP connection', details: parsed.error.flatten() });
    }
    if (!mcpStore.getMcpServer(id)) return reply.code(404).send({ error: 'MCP connection not found' });
    return mcpStore.updateMcpServer(id, parsed.data);
  });

  app.delete('/api/mcp-servers/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!mcpStore.deleteMcpServer(id)) {
      return reply.code(404).send({ error: 'MCP connection not found' });
    }
    return reply.code(204).send();
  });

  /** Show the exact .mcp.json a set of connections would produce. */
  app.post('/api/mcp-servers/preview', async (request, reply) => {
    const parsed = z
      .object({
        serverIds: z.array(z.string()).default([]),
        inlineConfig: z.string().nullable().default(null),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid request' });
    return { document: mcpStore.buildMcpDocument(parsed.data.serverIds, parsed.data.inlineConfig) };
  });
}
