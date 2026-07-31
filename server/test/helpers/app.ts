import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, InjectOptions } from 'fastify';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * A KubeClaude with its own database and a fake Claude CLI, driven through
 * `app.inject()` rather than a socket.
 *
 * The environment has to be set before anything imports `config` or `db`, which
 * both read it once at module load — hence the setup-then-import dance rather
 * than a plain helper function.
 */
export interface TestApp {
  app: FastifyInstance;
  dir: string;
  /** Cookie header carried between calls, the way a browser would. */
  cookie: string | null;
  request(options: InjectOptions): Promise<TestResponse>;
  as(credential: string): (options: InjectOptions) => Promise<TestResponse>;
  close(): Promise<void>;
}

export interface TestResponse {
  status: number;
  headers: Record<string, unknown>;
  body: string;
  json<T = unknown>(): T;
}

export interface TestAppOptions {
  /** Extra environment for this instance, applied before the modules load. */
  env?: Record<string, string>;
}

let counter = 0;

export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  counter += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kubeclaude-api-${counter}-`));

  process.env.DATA_DIR = dir;
  process.env.CLAUDE_BIN = path.join(here, '..', 'fixtures', 'fake-claude.mjs');
  process.env.SERVE_WEB = 'false';
  process.env.MAX_CONCURRENT_RUNS = '1';
  for (const [key, value] of Object.entries(options.env ?? {})) process.env[key] = value;

  const { migrate } = await import('../../src/db.js');
  const { buildServer } = await import('../../src/server.js');
  migrate();

  const app = await buildServer();
  await app.ready();

  const instance: TestApp = {
    app,
    dir,
    cookie: null,

    async request(injectOptions: InjectOptions): Promise<TestResponse> {
      const headers: Record<string, string> = {
        ...(injectOptions.headers as Record<string, string> | undefined),
      };
      if (instance.cookie && !headers.cookie) headers.cookie = instance.cookie;

      const response = await app.inject({ ...injectOptions, headers });

      // Keep the session the way a browser would, so a test reads as a session.
      const setCookie = response.headers['set-cookie'];
      const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      if (typeof raw === 'string') {
        const value = raw.split(';')[0] ?? '';
        instance.cookie = value.endsWith('=') ? null : value;
      }

      return {
        status: response.statusCode,
        headers: response.headers as Record<string, unknown>,
        body: response.body,
        json<T>() {
          return JSON.parse(response.body) as T;
        },
      };
    },

    /** The same app, addressed with an API key instead of a cookie. */
    as(credential: string) {
      return (injectOptions: InjectOptions) =>
        app
          .inject({
            ...injectOptions,
            headers: {
              ...(injectOptions.headers as Record<string, string> | undefined),
              'x-api-key': credential,
            },
          })
          .then((response) => ({
            status: response.statusCode,
            headers: response.headers as Record<string, unknown>,
            body: response.body,
            json<T>() {
              return JSON.parse(response.body) as T;
            },
          }));
    },

    async close() {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };

  return instance;
}

/** Complete first-run setup and keep the session, so tests can get to the API. */
export async function signIn(
  instance: TestApp,
  username = 'tester',
  password = 'a-good-password',
): Promise<{ apiKey: string }> {
  const response = await instance.request({
    method: 'POST',
    url: '/api/auth/setup',
    payload: { username, password },
  });
  if (response.status !== 201) {
    throw new Error(`setup failed (${response.status}): ${response.body}`);
  }
  return { apiKey: response.json<{ apiKey: string }>().apiKey };
}
