import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, beforeEach, afterEach, after } from 'node:test';

// notify.ts records a failed delivery to the error feed, which needs a
// migrated database — set up before anything imports the db module.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-notify-test-'));
process.env.DATA_DIR = tmpDir;

const { migrate } = await import('../src/db.js');
const { notifyOutcomeFor, notifyRun } = await import('../src/notify.js');
type Run = import('../src/types.js').Run;

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    promptId: 'prompt-1',
    promptName: 'Keep the cluster tidy',
    triggerId: null,
    triggerType: 'manual',
    status: 'succeeded',
    promptText: 'do the thing',
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1000,
    sessionId: null,
    exitCode: 0,
    error: null,
    numTurns: 1,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 150,
    resultText: 'done',
    model: 'claude-sonnet-5',
    modelUsage: null,
    durationApiMs: 500,
    serviceTier: null,
    resumeOfRunId: null,
    rootRunId: 'run-1',
    followUpText: null,
    resumeAttempt: 0,
    rateLimitResetAt: null,
    autoResumePending: false,
    completed: true,
    completionReason: null,
    ...overrides,
  };
}

test('notifyOutcomeFor picks the outcome only for runs actually worth telling about', () => {
  assert.equal(notifyOutcomeFor(run({ status: 'succeeded' })), 'success');
  assert.equal(notifyOutcomeFor(run({ status: 'failed' })), 'failure');
  assert.equal(notifyOutcomeFor(run({ status: 'timeout' })), 'failure');
  assert.equal(notifyOutcomeFor(run({ status: 'capped' })), 'failure');
  // Rate-limited with a resume scheduled is a pause, not an outcome.
  assert.equal(notifyOutcomeFor(run({ status: 'rate_limited', autoResumePending: true })), null);
  // Rate-limited with nothing coming back for it is stuck, and worth a page.
  assert.equal(notifyOutcomeFor(run({ status: 'rate_limited', autoResumePending: false })), 'failure');
  // The operator's own doing; never worth telling the operator about.
  assert.equal(notifyOutcomeFor(run({ status: 'cancelled' })), null);
  assert.equal(notifyOutcomeFor(run({ status: 'queued' })), null);
  assert.equal(notifyOutcomeFor(run({ status: 'running' })), null);
});

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response('ok', { status: 200 }));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('no webhook url means no request, regardless of the outcome', () => {
  notifyRun(run({ status: 'failed' }), { notifyWebhookUrl: '', notifyOnSuccess: true, notifyOnFailure: true });
  assert.equal(calls.length, 0);
});

test('each toggle gates its own outcome independently', () => {
  const settings = { notifyWebhookUrl: 'https://example.com/hook', notifyOnSuccess: false, notifyOnFailure: true };

  notifyRun(run({ status: 'succeeded' }), settings);
  assert.equal(calls.length, 0, 'success is off, so nothing is sent');

  notifyRun(run({ status: 'failed' }), settings);
  assert.equal(calls.length, 1, 'failure is on, so this one goes out');
  assert.equal(calls[0]!.url, 'https://example.com/hook');
  const body = JSON.parse(calls[0]!.init.body as string) as { outcome: string; run: { id: string } };
  assert.equal(body.outcome, 'failure');
  assert.equal(body.run.id, 'run-1');
});

test('a failing target is swallowed rather than thrown at the caller', () => {
  globalThis.fetch = () => Promise.reject(new Error('ECONNREFUSED'));
  // Nothing to await: the whole point is that this returns without the
  // target's failure ever reaching the run that triggered it.
  assert.doesNotThrow(() =>
    notifyRun(run({ status: 'failed' }), {
      notifyWebhookUrl: 'https://example.com/hook',
      notifyOnSuccess: false,
      notifyOnFailure: true,
    }),
  );
});
