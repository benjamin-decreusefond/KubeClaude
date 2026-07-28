import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import { claudeVersion } from '../claude/runner.js';
import { MODEL_CATALOG } from '../claude/models.js';
import { TOOL_PRESETS } from '../claude/tool-presets.js';
import {
  billingMode,
  claudeCredentials,
  config,
  forwardedEnvPrefixes,
  hasCredentials,
  shadowedCredentials,
} from '../config.js';
import { activeRunCount } from '../queue.js';
import { countRuns } from '../store/runs.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../store/settings.js';
import { getQuotaState, listWindows } from '../store/usage.js';
import { getDashboard } from '../store/stats.js';
import { settingsUpdateSchema } from './schemas.js';

const execFileAsync = promisify(execFile);

async function onPath(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));

  /**
   * Ready as soon as the server can serve. Deliberately does *not* fail when
   * Claude credentials are missing: that would drop the Service endpoints and
   * lock you out of the UI that tells you the credentials are missing. The UI
   * banner and `credentials` below are the signal instead.
   */
  app.get('/readyz', async () => ({ status: 'ok', credentials: hasCredentials() }));

  app.get('/api/status', async () => {
    const quota = getQuotaState();
    return {
      version: process.env.APP_VERSION ?? 'dev',
      claudeVersion: await claudeVersion(),
      credentialsConfigured: hasCredentials(),
      billingMode: billingMode(),
      maxConcurrentRuns: config.maxConcurrentRuns,
      activeRuns: activeRunCount(),
      queuedRuns: countRuns({ status: 'queued' }),
      awaitingResume: countRuns({ status: 'rate_limited' }),
      quota,
      settings: getSettings(),
    };
  });

  app.get('/api/models', async () => ({ models: MODEL_CATALOG }));

  app.get('/api/tool-presets', async () => ({ presets: TOOL_PRESETS }));

  /**
   * What a run can actually reach: which CLIs are on PATH and which pod env vars
   * are forwarded. Values are never returned, only names — so the UI can tell
   * you a GitHub token is wired up without exposing it.
   */
  app.get('/api/capabilities', async () => {
    const tools = await Promise.all(
      ['claude', 'git', 'gh', 'kubectl', 'rg', 'jq', 'node', 'python3'].map(async (name) => ({
        name,
        available: await onPath(name),
      })),
    );
    return {
      tools,
      credentials: {
        configured: hasCredentials(),
        mode: billingMode(),
        variables: Object.keys(claudeCredentials()).sort(),
        ignored: shadowedCredentials(),
      },
      forwardedEnvPrefixes,
      forwardedEnvNames: Object.keys(process.env)
        .filter((key) => forwardedEnvPrefixes.some((prefix) => key.startsWith(prefix)))
        .sort(),
      globalEnvNames: Object.keys(getSettings().globalEnv).sort(),
    };
  });

  app.get('/api/dashboard', async () => getDashboard());

  app.get('/api/usage', async () => ({
    quota: getQuotaState(),
    sessionWindows: listWindows('session', 24),
    weeklyWindows: listWindows('weekly', 12),
  }));

  app.get('/api/settings', async () => getSettings());

  /** The shipped defaults, so the UI can offer "restore" without duplicating them. */
  app.get('/api/settings/defaults', async () => DEFAULT_SETTINGS);

  app.patch('/api/settings', async (request, reply) => {
    const parsed = settingsUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid settings', details: parsed.error.flatten() });
    }
    return updateSettings(parsed.data);
  });
}
