import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config, hasCredentials } from './config.js';
import { migrate } from './db.js';
import { ensureDirectories } from './claude/runner.js';
import { logger } from './logger.js';
import { beginShutdown, drain } from './queue.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { failOrphanedRuns, pruneOldRuns } from './store/runs.js';
import { mcpRoutes } from './routes/mcp.js';
import { promptRoutes } from './routes/prompts.js';
import { runRoutes } from './routes/runs.js';
import { streamRoutes } from './routes/stream.js';
import { systemRoutes } from './routes/system.js';
import { triggerRoutes } from './routes/triggers.js';

const PUBLIC_PATHS = new Set(['/healthz', '/readyz']);

function tokenMatches(provided: string): boolean {
  const expected = Buffer.from(config.authToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function buildServer() {
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: true,
  });

  if (config.authToken) {
    app.addHook('onRequest', async (request, reply) => {
      if (PUBLIC_PATHS.has(request.url.split('?')[0] ?? '')) return;

      const header = request.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      // EventSource cannot set headers, so the stream endpoint also accepts ?token=.
      const queryToken =
        typeof (request.query as Record<string, unknown>)?.token === 'string'
          ? ((request.query as Record<string, string>).token as string)
          : '';
      const provided = bearer || queryToken;

      if (!provided || !tokenMatches(provided)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    });
  }

  app.setErrorHandler((error: FastifyError, request, reply) => {
    logger.error({ err: error.message, url: request.url, stack: error.stack }, 'request failed');
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Internal server error' : error.message });
  });

  await app.register(systemRoutes);
  await app.register(promptRoutes);
  await app.register(triggerRoutes);
  await app.register(runRoutes);
  await app.register(mcpRoutes);
  await app.register(streamRoutes);

  if (config.serveWeb && fs.existsSync(config.webDir)) {
    await app.register(fastifyStatic, { root: path.resolve(config.webDir), wildcard: false });
    // SPA fallback: anything that is not an API route serves index.html.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not found' });
      }
      return reply.sendFile('index.html');
    });
  } else if (config.serveWeb) {
    logger.warn({ webDir: config.webDir }, 'web assets not found, serving the API only');
  }

  return app;
}

async function main(): Promise<void> {
  ensureDirectories();
  migrate();

  const orphaned = failOrphanedRuns();
  if (orphaned > 0) logger.warn({ count: orphaned }, 'marked interrupted runs as failed');

  const pruned = pruneOldRuns(config.runRetentionDays);
  if (pruned > 0) logger.info({ count: pruned }, 'pruned old runs');

  if (!hasCredentials()) {
    logger.warn(
      {},
      'no Claude credentials found: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY before running prompts',
    );
  }

  const app = await buildServer();
  await app.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'KubeClaude is listening');

  startScheduler();
  // Pick up anything that was queued when the process last stopped.
  await drain();

  const daily = setInterval(
    () => {
      const count = pruneOldRuns(config.runRetentionDays);
      if (count > 0) logger.info({ count }, 'pruned old runs');
    },
    24 * 3_600_000,
  );
  daily.unref();

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    stopScheduler();
    clearInterval(daily);
    beginShutdown();
    await app.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((error) => {
  logger.error({ err: error instanceof Error ? error.stack : String(error) }, 'failed to start');
  process.exit(1);
});
