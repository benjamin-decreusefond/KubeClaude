import { effectiveMethod } from './auth/guard.js';
import { config, hasCredentials } from './config.js';
import { migrate } from './db.js';
import { ensureDirectories } from './claude/runner.js';
import { logger } from './logger.js';
import { beginShutdown, drain } from './queue.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { buildServer } from './server.js';
import { getAuthConfig, pruneSessions } from './store/auth.js';
import { failOrphanedRuns, pruneOldRuns } from './store/runs.js';

async function main(): Promise<void> {
  ensureDirectories();
  migrate();

  const orphaned = failOrphanedRuns();
  if (orphaned > 0) logger.warn({ count: orphaned }, 'marked interrupted runs as failed');

  const pruned = pruneOldRuns(config.runRetentionDays);
  if (pruned > 0) logger.info({ count: pruned }, 'pruned old runs');

  const staleSessions = pruneSessions();
  if (staleSessions > 0) logger.info({ count: staleSessions }, 'pruned expired sessions');

  const auth = effectiveMethod();
  const authConfig = getAuthConfig();
  if (auth.method === 'none' && !config.authToken) {
    logger.warn(
      {},
      'authentication is off: anyone who can reach this port can run Claude with whatever access it has',
    );
  } else if (auth.method !== 'none' && auth.method !== 'external' && !authConfig.configured) {
    logger.info({}, 'no password set yet: the UI will ask for one on first visit');
  } else {
    logger.info(
      { method: auth.method, requirement: authConfig.requirement, pinned: auth.locked },
      'authentication configured',
    );
  }

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
      pruneSessions();
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
