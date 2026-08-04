import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-shutdown-test-'));
process.env.DATA_DIR = tmpDir;
process.env.SERVE_WEB = 'false';

const { migrate } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * An open SSE connection has no reason to ever close itself, and Fastify's
 * default `close()` only closes idle keep-alive sockets — an active stream is
 * neither. Without `forceCloseConnections`, a single open browser tab on
 * `/api/stream` would hang shutdown for the full termination grace period and
 * force Kubernetes to SIGKILL instead of a clean exit.
 */
test('the server closes promptly even with an open SSE connection', async () => {
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('expected a bound TCP address');
  const base = `http://127.0.0.1:${address.port}`;

  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'a-good-password' }),
  });
  const { apiKey } = (await setup.json()) as { apiKey: string };

  // Opened and left open on purpose — nothing here ever reads it or closes it,
  // the way an idle browser tab would leave a real EventSource.
  const stream = await fetch(`${base}/api/stream?apikey=${apiKey}`);
  assert.equal(stream.status, 200);

  const closed = app.close();
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    closed.then(() => 'closed'),
    new Promise((resolve) => setTimeout(() => resolve(timedOut), 5_000)),
  ]);

  assert.notEqual(result, timedOut, 'app.close() must not hang while an SSE connection is open');

  await stream.body?.cancel().catch(() => undefined);
});
