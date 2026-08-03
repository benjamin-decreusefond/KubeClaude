import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

// The db module resolves its path from config at import time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-quota-reset-'));
process.env.DATA_DIR = tmpDir;

const { migrate } = await import('../src/db.js');
const { createPrompt } = await import('../src/store/prompts.js');
const { createTrigger, updateTrigger } = await import('../src/store/triggers.js');
const {
  getActiveWindow,
  getKnownResetAt,
  getQuotaState,
  listQuotaResets,
  openWindows,
  recordQuotaReset,
} = await import('../src/store/usage.js');
const { shouldFire } = await import('../src/scheduler.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makePrompt(name: string) {
  return createPrompt({
    kind: 'scheduled',
    title: null,
    name,
    description: '',
    prompt: 'do the thing',
    enabled: true,
    model: null,
    fallbackModel: null,
    effort: null,
    maxBudgetUsd: null,
    workingDir: null,
    addDirs: [],
    repoUrl: null,
    repoRef: null,
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: null,
    systemPrompt: null,
    agentsJson: null,
    builtinTools: null,
    settingSources: null,
    maxTurns: null,
    timeoutSeconds: 600,
    env: {},
    mcpConfig: null,
    mcpServerIds: [],
    settingsJson: null,
    claudeMd: null,
    continueSession: false,
    autoResume: true,
    maxAutoResumes: 5,
    resumePrompt: null,
    completionCheck: 'marker',
    completionMarker: null,
    judgeModel: null,
  });
}

test('an observed reset moves the open window off the five-hour estimate', () => {
  const t0 = new Date('2026-09-01T10:00:00Z');
  // KubeClaude books its first run and guesses the window ends five hours later.
  openWindows(t0);
  assert.equal(getActiveWindow('session', t0)!.endsAt, '2026-09-01T15:00:00.000Z');
  assert.equal(getActiveWindow('session', t0)!.endsAtObserved, false);

  // Claude then refuses a run and says exactly when the allowance returns. The
  // real session started before KubeClaude ran anything, so it is back sooner.
  const observed = recordQuotaReset(
    { kind: 'session', resetAt: '2026-09-01T13:20:00.000Z', runId: null, evidence: 'usage limit reached|…' },
    t0,
  );
  assert.ok(observed);

  const corrected = getActiveWindow('session', t0)!;
  assert.equal(corrected.endsAt, '2026-09-01T13:20:00.000Z');
  assert.equal(corrected.endsAtObserved, true);

  // And the gauge reports it as a fact rather than as arithmetic.
  const quota = getQuotaState(t0);
  assert.equal(quota.session.resetsAt, '2026-09-01T13:20:00.000Z');
  assert.equal(quota.session.resetsAtObserved, true);
});

test('a reset already in the past is not recorded', () => {
  const now = new Date('2026-09-02T10:00:00Z');
  assert.equal(recordQuotaReset({ kind: 'session', resetAt: '2026-09-02T09:00:00.000Z', runId: null, evidence: null }, now), null);
  assert.equal(recordQuotaReset({ kind: 'session', resetAt: 'not a date', runId: null, evidence: null }, now), null);
});

test('the nearest still-future observation is the one that counts', () => {
  const now = new Date('2026-09-03T10:00:00Z');
  recordQuotaReset({ kind: 'weekly', resetAt: '2026-09-06T00:00:00.000Z', runId: null, evidence: null }, now);
  recordQuotaReset({ kind: 'weekly', resetAt: '2026-09-04T00:00:00.000Z', runId: null, evidence: null }, now);
  assert.equal(getKnownResetAt('weekly', now), '2026-09-04T00:00:00.000Z');
  // Past observations stop counting once they have happened.
  assert.equal(getKnownResetAt('weekly', new Date('2026-09-05T00:00:00Z')), '2026-09-06T00:00:00.000Z');
  assert.equal(getKnownResetAt('weekly', new Date('2026-09-07T00:00:00Z')), null);
});

test('the same reset observed twice is recorded once', () => {
  const now = new Date('2026-09-08T10:00:00Z');
  recordQuotaReset({ kind: 'session', resetAt: '2026-09-08T14:00:00.000Z', runId: 'run-a', evidence: null }, now);
  recordQuotaReset({ kind: 'session', resetAt: '2026-09-08T14:00:00.000Z', runId: 'run-b', evidence: null }, now);
  const seen = listQuotaResets('session').filter((row) => row.resetAt === '2026-09-08T14:00:00.000Z');
  assert.equal(seen.length, 1);
});

test('session_reset waits for the observed reset, not the five-hour boundary', () => {
  const prompt = makePrompt('waits-for-the-real-reset');
  const trigger = createTrigger({
    promptId: prompt.id,
    type: 'session_reset',
    enabled: true,
    cronExpression: null,
    timezone: 'UTC',
    config: {},
  });

  const t0 = new Date('2026-09-10T10:00:00Z');
  openWindows(t0);
  // Claude says the allowance is back at 16:00 — an hour past where the local
  // arithmetic would have rolled the window over.
  recordQuotaReset({ kind: 'session', resetAt: '2026-09-10T16:00:00.000Z', runId: null, evidence: null }, t0);

  const armed = updateTrigger(trigger.id, { lastFiredAt: t0.toISOString(), nextFireAt: null })!;

  // The old behaviour fired here, on the guessed five-hour boundary.
  const early = shouldFire(armed, new Date('2026-09-10T15:00:01Z'));
  assert.equal(early.fire, false);
  assert.equal(early.nextFireAt, '2026-09-10T16:00:00.000Z');

  // It fires at the moment the quota is actually back.
  assert.equal(shouldFire(armed, new Date('2026-09-10T16:00:01Z')).fire, true);
});
