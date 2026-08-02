import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listBackups } from '../db.js';
import * as errorStore from '../store/errors.js';

const idParams = z.object({ id: z.string().min(1) });

const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });

/**
 * What the browser reports. `source` is not accepted from the client: an error
 * arriving over HTTP is a browser error by definition, and letting the caller
 * label it as a server fault would put lies in the one place you look when
 * something is wrong.
 */
const reportSchema = z.object({
  message: z.string().min(1).max(2000),
  detail: z.string().max(20_000).optional(),
  context: z.string().max(500).optional(),
});

export async function errorRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/errors', async (request, reply) => {
    const query = listQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });
    return { items: errorStore.listErrors(query.data.limit), total: errorStore.countErrors() };
  });

  app.post('/api/errors', async (request, reply) => {
    const parsed = reportSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid error report', details: parsed.error.flatten() });
    }
    const recorded = errorStore.recordError({
      source: 'browser',
      message: parsed.data.message,
      detail: parsed.data.detail ?? null,
      context: parsed.data.context ?? null,
    });
    return reply.code(201).send(recorded);
  });

  app.delete('/api/errors/:id', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });
    if (!errorStore.dismissError(params.data.id)) return reply.code(404).send({ error: 'Not found' });
    return reply.code(204).send();
  });

  app.delete('/api/errors', async (_request, reply) => {
    const cleared = errorStore.clearErrors();
    return reply.code(200).send({ cleared });
  });

  /**
   * The copies taken before each migration. Names only — restoring one means
   * stopping the pod and swapping the file, which is deliberately not something
   * the app can do to itself while it is running on top of it.
   */
  app.get('/api/backups', async () => ({ items: listBackups() }));
}
