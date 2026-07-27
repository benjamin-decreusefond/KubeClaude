import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after, beforeEach } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-usage-'));
process.env.DATA_DIR = tmpDir;

const { migrate, db } = await import('../src/db.js');
const { openWindows, addUsage, getQuotaState, budgetedTokens } = await import('../src/store/usage.js');
const { updateSettings } = await import('../src/store/settings.js');
type UsageWindow = import('../src/types.js').UsageWindow;

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  db.prepare('DELETE FROM usage_windows').run();
  updateSettings({ sessionTokenBudget: 0, weeklyTokenBudget: 0, quotaReservePct: 0, budgetBasis: 'weighted' });
});

/** A shape typical of a real agentic run: cache reads dwarf everything else. */
const agenticWindow: UsageWindow = {
  id: 'w',
  kind: 'session',
  startedAt: '2026-07-27T10:00:00.000Z',
  endsAt: '2026-07-27T15:00:00.000Z',
  inputTokens: 4_000,
  outputTokens: 6_000,
  cacheCreationTokens: 20_000,
  cacheReadTokens: 900_000,
  totalTokens: 930_000,
  costUsd: 1.2,
  runCount: 3,
};

test('the weighted basis prices cache traffic the way Anthropic does', () => {
  // 4k + 6k + 20k*1.25 + 900k*0.1 = 125_000
  assert.equal(budgetedTokens(agenticWindow, 'weighted'), 125_000);
});

test('the other bases are the raw sum and the uncached pair', () => {
  assert.equal(budgetedTokens(agenticWindow, 'total'), 930_000);
  assert.equal(budgetedTokens(agenticWindow, 'input_output'), 10_000);
});

test('a single agentic run does not exhaust a subscription-sized budget', () => {
  // The community estimate for a Pro plan, which is the number a user is most
  // likely to type in. Under the raw sum one run would read as 20x over.
  updateSettings({ sessionTokenBudget: 44_000 });
  const at = new Date('2026-07-27T11:00:00Z');
  const windows = openWindows(at);
  addUsage(windows.session.id, {
    inputTokens: 1_200,
    outputTokens: 2_400,
    cacheCreationTokens: 8_000,
    cacheReadTokens: 260_000,
    totalTokens: 271_600,
    costUsd: 0.4,
  });

  const weighted = getQuotaState(at).session;
  // 1_200 + 2_400 + 10_000 + 26_000 = 39_600 — tight, but not blown.
  assert.equal(weighted.used, 39_600);
  assert.equal(weighted.basis, 'weighted');
  assert.equal(weighted.exhausted, false);

  updateSettings({ budgetBasis: 'total' });
  const raw = getQuotaState(at).session;
  assert.equal(raw.used, 271_600);
  assert.equal(raw.exhausted, true);
});

test('the quota guard reads the configured basis', () => {
  updateSettings({ sessionTokenBudget: 44_000, quotaGuardEnabled: true, budgetBasis: 'total' });
  const at = new Date('2026-07-27T11:00:00Z');
  const windows = openWindows(at);
  addUsage(windows.session.id, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 500_000,
    totalTokens: 500_000,
    costUsd: 0.1,
  });

  assert.equal(getQuotaState(at).canRun, false);
  updateSettings({ budgetBasis: 'weighted' });
  // The same 500k cache reads weigh 50k, still over a 44k budget.
  assert.equal(getQuotaState(at).canRun, false);
  updateSettings({ budgetBasis: 'input_output' });
  assert.equal(getQuotaState(at).canRun, true);
  updateSettings({ quotaGuardEnabled: false });
});
