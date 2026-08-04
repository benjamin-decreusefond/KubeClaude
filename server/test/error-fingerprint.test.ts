import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-error-fp-'));
process.env.DATA_DIR = tmpDir;
process.env.SERVE_WEB = 'false';

const { migrate } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const errorStore = await import('../src/store/errors.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/**
 * The error feed counts distinct faults, and the request's context is part of
 * what makes one distinct. Keyed on the URL as called, one broken endpoint that
 * the browser polls writes a new row per poll — each with its own run id and
 * `after=` cursor — and flushes every other error out of the feed within a
 * couple of hundred of them.
 */
test('one broken endpoint polled many times is one fault, not one per poll', async () => {
  const app = await buildServer();
  // Registered before `ready()`, so it goes through the same error handler
  // every other route does.
  app.get('/api/pretend-broken/:id/events', async () => {
    throw new Error('the thing that keeps breaking');
  });
  await app.ready();

  try {
    // The guard sits in front of every /api/ route, so the calls below have to
    // be a signed-in caller rather than a rejected one.
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { username: 'tester', password: 'a-good-password' },
    });
    assert.equal(setup.statusCode, 201);
    const { apiKey } = setup.json<{ apiKey: string }>();

    errorStore.clearErrors();

    for (let i = 0; i < 12; i += 1) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/pretend-broken/run-${i}/events?after=${i * 10}`,
        headers: { 'x-api-key': apiKey },
      });
      assert.equal(response.statusCode, 500);
    }

    assert.equal(errorStore.countErrors(), 1, 'every poll of the same broken route is the same fault');
    const [entry] = errorStore.listErrors();
    assert.equal(entry?.count, 12);
    // Named by the route as registered, so the row says which endpoint broke
    // rather than which id happened to be polled last.
    assert.equal(entry?.context, 'GET /api/pretend-broken/:id/events');
  } finally {
    await app.close();
  }
});
