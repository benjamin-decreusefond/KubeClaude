import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { bus } from '../events.js';
import { getQuotaState } from '../store/usage.js';
import type { Run, RunEvent } from '../types.js';

const query = z.object({
  /** Restrict `run:event` frames to a single run; run status frames always come through. */
  runId: z.string().optional(),
});

function write(reply: FastifyReply, event: string, data: unknown): void {
  if (reply.raw.writableEnded) return;
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stream', async (request, reply) => {
    const parsed = query.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid query' });
    const filterRunId = parsed.data.runId;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Traefik and other proxies buffer by default, which breaks live output.
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 3000\n\n');

    const onRunCreated = (run: Run) => write(reply, 'run:created', run);
    const onRunUpdated = (run: Run) => write(reply, 'run:updated', run);
    const onRunEvent = (event: RunEvent) => {
      if (filterRunId && event.runId !== filterRunId) return;
      write(reply, 'run:event', event);
    };
    const onQuota = () => write(reply, 'quota:changed', getQuotaState());

    bus.on('run:created', onRunCreated);
    bus.on('run:updated', onRunUpdated);
    bus.on('run:event', onRunEvent);
    bus.on('quota:changed', onQuota);

    const heartbeat = setInterval(() => {
      if (reply.raw.writableEnded) return;
      reply.raw.write(': ping\n\n');
    }, 25_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      bus.off('run:created', onRunCreated);
      bus.off('run:updated', onRunUpdated);
      bus.off('run:event', onRunEvent);
      bus.off('quota:changed', onQuota);
    };
    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // Keep the fastify reply open; the raw socket is managed above.
    return reply;
  });
}
