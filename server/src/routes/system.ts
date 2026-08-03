import type { FastifyInstance } from 'fastify';
import { claudeVersion } from '../claude/runner.js';
import { probeBrowser, probeTools } from '../claude/environment.js';
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
import { countErrors } from '../store/errors.js';
import { countQueuedByKind, countRuns } from '../store/runs.js';
import { DEFAULT_SETTINGS, getSettings, updateSettings } from '../store/settings.js';
import { getQuotaState, listWindows } from '../store/usage.js';
import { getDashboard } from '../store/stats.js';
import { settingsUpdateSchema } from './schemas.js';

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
      // Split out, because the sidebar puts a badge next to Prompts and a goal's
      // queued iteration is not something the Prompts page can show you.
      queuedByKind: countQueuedByKind(),
      awaitingResume: countRuns({ status: 'rate_limited' }),
      // So the sidebar can show that something went wrong without polling a
      // second endpoint for it.
      errorCount: countErrors(),
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
    const tools = await probeTools();
    const settings = getSettings();
    return {
      tools,
      /**
       * The headless browser, reported separately because it is not on PATH:
       * it lives under PLAYWRIGHT_BROWSERS_PATH and is found by walking it.
       */
      browser: probeBrowser(),
      /**
       * What a run's git will do before it is asked to. The token is reported
       * as present or not, never echoed.
       */
      git: {
        userName: settings.gitUserName,
        userEmail: settings.gitUserEmail,
        githubToken: config.exposeGitHubToken && Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
        tokenWithheld: !config.exposeGitHubToken && Boolean(process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
      },
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
