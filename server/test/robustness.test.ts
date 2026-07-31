import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';

/**
 * The ways this thing can be asked to do two contradictory things at once.
 *
 * Each of these was a live defect: a process that fell over, an instance whose
 * first password could be overwritten by whoever was second, and a goal that
 * stopped itself because the pod had been redeployed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-robust-'));

process.env.DATA_DIR = tmpDir;
process.env.CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.FORWARD_ENV_PREFIXES = 'FAKE_';
process.env.MAX_CONCURRENT_RUNS = '1';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate, db } = await import('../src/db.js');
const promptStore = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const goalStore = await import('../src/store/goals.js');
const authStore = await import('../src/store/auth.js');
const { enqueueRun, cancelRunsForPrompt, activeRunCount } = await import('../src/queue.js');
const { reviewIteration } = await import('../src/goals.js');
import type { Prompt } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;
function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  counter += 1;
  return promptStore.createPrompt({
    kind: 'scheduled',
    title: null,
    name: `robust-${counter}`,
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
    timeoutSeconds: 60,
    env: {},
    mcpConfig: null,
    mcpServerIds: [],
    settingsJson: null,
    claudeMd: null,
    continueSession: false,
    autoResume: false,
    maxAutoResumes: 0,
    resumePrompt: null,
    completionCheck: 'never',
    completionMarker: null,
    judgeModel: null,
    ...overrides,
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('condition never became true');
}

test('deleting a prompt while it is running does not take the server with it', async () => {
  // `burn` keeps streaming output until it is killed, which is what makes the
  // race reachable: the CLI is mid-sentence when the run row disappears.
  process.env.FAKE_CLAUDE_MODE = 'burn';
  const prompt = makePrompt();
  const run = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;

  await waitFor(() => runStore.getRun(run.id)?.status === 'running');
  await waitFor(() => runStore.listEvents(run.id).length > 2);

  const crashes: unknown[] = [];
  const onCrash = (error: unknown) => crashes.push(error);
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  try {
    cancelRunsForPrompt(prompt.id);
    promptStore.deletePrompt(prompt.id);

    // Long enough for anything still streaming to try to write.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(crashes, [], 'writing output for a deleted run must not throw');
  } finally {
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
    delete process.env.FAKE_CLAUDE_MODE;
  }

  assert.equal(runStore.getRun(run.id), null);
  // And the Claude process was stopped rather than left running for a prompt
  // that no longer exists.
  await waitFor(() => activeRunCount() === 0);
});

test('an event for a run that has gone away is dropped, not thrown', () => {
  const prompt = makePrompt();
  const run = enqueueRun({ promptId: prompt.id, triggerType: 'manual', skipIfBusy: false })!;
  db.prepare('DELETE FROM runs WHERE id = ?').run(run.id);

  assert.equal(runStore.appendEvent(run.id, 'system', { kind: 'late' }), null);
});

test('cancelling a prompt that has queued runs clears them out', () => {
  const prompt = makePrompt();
  const first = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;
  const second = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;

  cancelRunsForPrompt(prompt.id);

  for (const run of [first, second]) {
    const status = runStore.getRun(run.id)?.status;
    assert.ok(status !== 'queued', `run ${run.id} should not still be queued (was ${status})`);
  }
});

test('only one of two simultaneous first-run setups can win', async () => {
  authStore.updateAuthConfig({ username: 'owner' });
  db.prepare('UPDATE auth_config SET password_hash = NULL WHERE id = 1').run();

  // Hashing is slow on purpose, which is exactly what opens the window: both
  // requests can pass a "has it been set up?" check before either has written.
  const attempts = ['the-owners-password', 'somebody-elses-password'];
  const applied = await Promise.all(attempts.map((password) => authStore.initialisePassword(password)));

  // Which of the two gets there first is a race and does not matter. That only
  // one of them takes effect — and that the loser is told so rather than
  // silently overwriting the winner — is the whole point.
  assert.equal(applied.filter(Boolean).length, 1, 'exactly one setup should apply');

  const winner = attempts[applied.indexOf(true)]!;
  const loser = attempts[applied.indexOf(false)]!;
  assert.equal(await authStore.verifyPassword('owner', winner), true);
  assert.equal(await authStore.verifyPassword('owner', loser), false);
});

test('a restart mid-iteration is not held against a goal', async () => {
  const prompt = makePrompt({ kind: 'goal', name: 'goal-restart', completionCheck: 'always' });
  const goal = goalStore.createGoal({
    promptId: prompt.id,
    name: 'Keep going',
    description: '',
    objectives: goalStore.makeObjectives(['Something']),
    status: 'active',
    cadenceMinutes: 0,
    maxIterations: 0,
    stopWhenAchieved: true,
    reviewModel: null,
  });

  // A run that was in flight when the process went down, closed out the way
  // startup closes it out.
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'goal',
    promptText: 'work',
  });
  runStore.updateRun(run.id, { status: 'running' });
  runStore.failOrphanedRuns();

  const interrupted = runStore.getRun(run.id)!;
  assert.equal(interrupted.status, 'failed');
  assert.equal(interrupted.completionReason, 'restart');

  await reviewIteration(goal, interrupted);

  const [entry] = goalStore.listIterations(goal.id);
  // Recorded honestly, but as an interruption rather than a failure — three
  // deploys in a row must not pause a goal that is doing nothing wrong.
  assert.equal(entry?.runStatus, 'interrupted');
  assert.match(entry?.summary ?? '', /restarted/i);
});

test('pruning runs leaves the progress log readable rather than pointing at nothing', () => {
  const prompt = makePrompt({ kind: 'goal', name: 'goal-prune' });
  const goal = goalStore.createGoal({
    promptId: prompt.id,
    name: 'Old goal',
    description: '',
    objectives: [],
    status: 'paused',
    cadenceMinutes: 0,
    maxIterations: 0,
    stopWhenAchieved: true,
    reviewModel: null,
  });

  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'goal',
    promptText: 'work',
  });
  runStore.updateRun(run.id, { status: 'succeeded' });
  goalStore.addIteration({
    goalId: goal.id,
    runId: run.id,
    summary: 'Did something once',
    nextStep: null,
    achieved: [],
    source: 'report',
    runStatus: 'succeeded',
  });

  // Age it past any retention window and prune.
  db.prepare("UPDATE runs SET queued_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(run.id);
  assert.ok(runStore.pruneOldRuns(30) > 0);

  const [entry] = goalStore.listIterations(goal.id);
  assert.equal(entry?.summary, 'Did something once');
  // The entry survives; the link to a run that no longer exists does not.
  assert.equal(entry?.runId, null);
});
