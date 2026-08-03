import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

// The db module resolves its path from config at import time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-test-'));
process.env.DATA_DIR = tmpDir;

const { migrate, db } = await import('../src/db.js');
const { createPrompt } = await import('../src/store/prompts.js');
const { createTrigger, updateTrigger } = await import('../src/store/triggers.js');
const { openWindows } = await import('../src/store/usage.js');
const { updateSettings } = await import('../src/store/settings.js');
const { shouldFire, resumeReadyAt } = await import('../src/scheduler.js');
type TriggerType = import('../src/types.js').TriggerType;

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
    workingDir: null,
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: null,
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

function makeTrigger(promptId: string, overrides: Partial<Parameters<typeof createTrigger>[0]> = {}) {
  return createTrigger({
    promptId,
    type: 'session_reset',
    enabled: true,
    cronExpression: null,
    timezone: 'UTC',
    config: {},
    ...overrides,
  });
}

test('a session_reset trigger fires once per 5h window', () => {
  const prompt = makePrompt('session-reset');
  const trigger = makeTrigger(prompt.id, { type: 'session_reset' });
  const t0 = new Date('2026-07-27T10:00:00Z');

  // No window open yet: the whole allowance is free, so fire now.
  const first = shouldFire(trigger, t0);
  assert.equal(first.fire, true);
  assert.equal(first.nextFireAt, new Date('2026-07-27T15:00:00Z').toISOString());

  // The run it queued opens the window; the trigger must not fire again inside it.
  openWindows(t0);
  const armed = updateTrigger(trigger.id, { lastFiredAt: t0.toISOString(), nextFireAt: first.nextFireAt })!;
  assert.equal(shouldFire(armed, new Date('2026-07-27T12:30:00Z')).fire, false);
  assert.equal(shouldFire(armed, new Date('2026-07-27T14:59:00Z')).fire, false);

  // Once the window rolls over, the quota is back and it fires again.
  assert.equal(shouldFire(armed, new Date('2026-07-27T15:00:01Z')).fire, true);
});

test('a session_reset trigger added while a window is already open waits for it, not fires early', () => {
  const prompt = makePrompt('session-reset-late-add');
  const opened = new Date('2026-07-27T10:00:00Z');
  // Some other run already opened the window an hour ago, unrelated to this
  // brand-new trigger — which has no lastFiredAt/nextFireAt of its own yet.
  openWindows(opened);
  const trigger = makeTrigger(prompt.id, { type: 'session_reset' });

  const evaluatedLate = shouldFire(trigger, new Date('2026-07-27T11:00:00Z'));
  assert.equal(evaluatedLate.fire, false);
  assert.equal(evaluatedLate.nextFireAt, new Date('2026-07-27T15:00:00Z').toISOString());

  // And it does fire once the window that was already running rolls over.
  assert.equal(shouldFire(trigger, new Date('2026-07-27T15:00:01Z')).fire, true);
});

test('a cron trigger fires when its schedule comes due and only catches up once', () => {
  const prompt = makePrompt('cron-prompt');
  const trigger = makeTrigger(prompt.id, {
    type: 'cron',
    cronExpression: '0 9 * * *',
    timezone: 'UTC',
  });
  const armed = updateTrigger(trigger.id, { lastFiredAt: '2026-07-25T09:00:00.000Z' })!;

  assert.equal(shouldFire(armed, new Date('2026-07-26T08:59:00Z')).fire, false);
  // Two days of downtime still produces exactly one decision to fire.
  const due = shouldFire(armed, new Date('2026-07-27T10:00:00Z'));
  assert.equal(due.fire, true);
  assert.equal(due.nextFireAt, new Date('2026-07-28T09:00:00Z').toISOString());
});

test('an invalid cron expression never fires', () => {
  const prompt = makePrompt('bad-cron');
  const trigger = makeTrigger(prompt.id, { type: 'cron', cronExpression: 'not a cron' });
  assert.equal(shouldFire(trigger, new Date()).fire, false);
});

test('an interval trigger respects its period', () => {
  const prompt = makePrompt('interval-prompt');
  const trigger = makeTrigger(prompt.id, { type: 'interval', config: { intervalMinutes: 30 } });
  assert.equal(shouldFire(trigger, new Date('2026-07-27T10:00:00Z')).fire, true);

  const armed = updateTrigger(trigger.id, { lastFiredAt: '2026-07-27T10:00:00.000Z' })!;
  assert.equal(shouldFire(armed, new Date('2026-07-27T10:20:00Z')).fire, false);
  assert.equal(shouldFire(armed, new Date('2026-07-27T10:31:00Z')).fire, true);
});

test('quota_available waits until enough of the budget is free', () => {
  updateSettings({
    sessionTokenBudget: 1_000_000,
    weeklyTokenBudget: 10_000_000,
    quotaReservePct: 0,
    budgetBasis: 'total',
  });
  const prompt = makePrompt('quota-prompt');
  const trigger = makeTrigger(prompt.id, {
    type: 'quota_available',
    config: { minSessionPctAvailable: 50, minIntervalMinutes: 60 },
  });
  const now = new Date('2026-07-28T10:00:00Z');

  // Nothing spent yet: 100% free.
  assert.equal(shouldFire(trigger, now).fire, true);

  // Burn 80% of the session budget and it must hold off.
  const windows = openWindows(now);
  db.prepare('UPDATE usage_windows SET total_tokens = ? WHERE id = ?').run(800_000, windows.session.id);
  assert.equal(shouldFire(trigger, now).fire, false);

  updateSettings({ sessionTokenBudget: 0, weeklyTokenBudget: 0, budgetBasis: 'weighted' });
});

test('a minimum interval overrides every trigger type', () => {
  const prompt = makePrompt('throttled');
  const trigger = makeTrigger(prompt.id, { type: 'session_reset', config: { minIntervalMinutes: 120 } });
  const armed = updateTrigger(trigger.id, { lastFiredAt: '2026-07-27T10:00:00.000Z' })!;
  assert.equal(shouldFire(armed, new Date('2026-07-27T11:00:00Z')).fire, false);
});

test('resumeReadyAt honours the reset time Claude reported', () => {
  const now = new Date('2026-07-27T10:00:00Z');
  const ready = resumeReadyAt('2026-07-27T15:00:00.000Z', 2, now);
  assert.equal(ready.toISOString(), '2026-07-27T15:02:00.000Z');
});

test('resumeReadyAt falls back to the end of the open session window', () => {
  const now = new Date('2026-07-29T10:00:00Z');
  openWindows(now);
  const ready = resumeReadyAt(null, 0, now);
  assert.equal(ready.toISOString(), '2026-07-29T15:00:00.000Z');
});

test('every trigger type is handled by shouldFire', () => {
  const types: TriggerType[] = ['cron', 'interval', 'session_reset', 'weekly_reset', 'quota_available'];
  const prompt = makePrompt('coverage');
  for (const triggerType of types) {
    const trigger = makeTrigger(prompt.id, { type: triggerType });
    assert.doesNotThrow(() => shouldFire(trigger, new Date()));
  }
});
