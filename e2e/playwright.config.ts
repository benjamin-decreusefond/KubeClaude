import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dataDir = path.join(here, '.tmp/data');

const PORT = Number(process.env.E2E_PORT ?? 8899);

/**
 * The end-to-end layer: the built server, the built SPA, and a real browser.
 *
 * It runs against a throwaway database and the fake Claude CLI from the server
 * test fixtures, so a full pass costs nothing, touches no cluster and spends no
 * quota — which is what makes it safe to run on every pull request and from
 * inside a KubeClaude that is working on itself.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  // A shared server and one database mean these tests are a sequence, not a set.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Set PLAYWRIGHT_CHROMIUM_PATH when the browser is provisioned outside
    // Playwright's own download directory, as it is in some containers.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },

  projects: [
    // First-run setup happens once per server, before anything that needs a
    // password to exist.
    { name: 'setup', testMatch: /first-run\.setup\.ts/, testDir: '.' },
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, dependencies: ['setup'] },
  ],

  webServer: {
    // A fresh database every run: these tests start from first-run setup, which
    // only exists once per instance.
    command: `rm -rf "${dataDir}" && node ${path.join(root, 'server/dist/index.js')}`,
    cwd: root,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      WEB_DIR: path.join(root, 'web/dist'),
      CLAUDE_BIN: path.join(root, 'server/test/fixtures/fake-claude.mjs'),
      // Nothing here should ever start a real Claude, so give it no way to.
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_API_KEY: '',
      MAX_CONCURRENT_RUNS: '1',
      SCHEDULER_INTERVAL_MS: '2000',
      APP_VERSION: 'e2e',
      LOG_LEVEL: 'warn',
    },
  },
});
