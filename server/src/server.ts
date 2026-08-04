import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { authenticate, isPublicPath, localBypassApplies } from './auth/guard.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { agentRoutes } from './routes/agents.js';
import { authRoutes } from './routes/auth.js';
import { chatRoutes } from './routes/chats.js';
import { errorRoutes } from './routes/errors.js';
import { goalRoutes } from './routes/goals.js';
import { mcpRoutes } from './routes/mcp.js';
import { promptRoutes } from './routes/prompts.js';
import { runRoutes } from './routes/runs.js';
import { streamRoutes } from './routes/stream.js';
import { systemRoutes } from './routes/system.js';
import { triggerRoutes } from './routes/triggers.js';
import { webhookRoutes } from './routes/webhooks.js';
import { recordError } from './store/errors.js';

/**
 * The HTTP server, assembled but not listening.
 *
 * Kept apart from `index.ts` so that importing it does not start a scheduler, a
 * queue or a process that never exits: a test can build the app, drive it with
 * `app.inject()`, and let it go.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 4 * 1024 * 1024,
    trustProxy: config.trustProxy,
    // Fastify's default only closes idle keep-alive sockets on `close()` — an
    // SSE stream is neither idle nor ever going to close itself, so a single
    // open browser tab would otherwise hang shutdown for the full termination
    // grace period and force Kubernetes to SIGKILL instead.
    forceCloseConnections: true,
  });

  /**
   * Authentication gates the API, not the static shell. Serving index.html and
   * its assets unauthenticated costs nothing — they hold no data — and it is the
   * only way somebody can reach the login screen at all.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (isPublicPath(request.url)) return;

    const outcome = await authenticate(request);
    if (outcome.allowed) return;

    // Only once the real check has failed, so "on the LAN" can never be
    // mistaken for "authenticated" when both would have passed.
    if (localBypassApplies(request)) return;

    if (outcome.challenge) reply.header('www-authenticate', 'Basic realm="KubeClaude"');
    return reply.code(401).send({
      error: outcome.setupRequired ? 'This instance has no password set yet' : 'Unauthorized',
      setupRequired: outcome.setupRequired,
    });
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    logger.error({ err: error.message, url: request.url, stack: error.stack }, 'request failed');
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    // Only what nobody asked for: a 4xx is the API refusing a bad request, which
    // is it working. A 500 is a bug, and belongs in the feed.
    if (status >= 500) {
      recordError({
        source: 'server',
        message: error.message,
        detail: error.stack ?? null,
        context: `${request.method} ${request.url}`,
      });
    }
    reply.code(status).send({ error: status === 500 ? 'Internal server error' : error.message });
  });

  await app.register(authRoutes);
  await app.register(systemRoutes);
  await app.register(promptRoutes);
  await app.register(triggerRoutes);
  await app.register(webhookRoutes);
  await app.register(runRoutes);
  await app.register(mcpRoutes);
  await app.register(agentRoutes);
  await app.register(chatRoutes);
  await app.register(errorRoutes);
  await app.register(goalRoutes);
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
