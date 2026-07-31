import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after, beforeEach } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-goal-test-'));

process.env.DATA_DIR = tmpDir;
process.env.CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.MAX_CONCURRENT_RUNS = '1';
process.env.FORWARD_ENV_PREFIXES = 'FAKE_';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate } = await import('../src/db.js');
const { createPrompt } = await import('../src/store/prompts.js');
const goalStore = await import('../src/store/goals.js');
const runStore = await import('../src/store/runs.js');
const { buildIterationPrompt, parseIterationReport, sweepGoals } = await import('../src/goals.js');
import type { Goal, Prompt } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_CLAUDE_RESULT;
  delete process.env.FAKE_CLAUDE_MODE;
  // The sweep is global: a goal left active by an earlier test would keep
  // iterating through the next one and blur what it is measuring.
  for (const goal of goalStore.listActiveGoals()) goalStore.updateGoal(goal.id, { status: 'paused' });
});

let counter = 0;

function makeGoal(overrides: Partial<Goal> = {}, objectives = ['Ship the thing', 'Document it']): {
  goal: Goal;
  prompt: Prompt;
} {
  counter += 1;
  const prompt = createPrompt({
    kind: 'goal',
    name: `goal-prompt-${counter}`,
    title: `Goal ${counter}`,
    description: '',
    prompt: 'driven by a goal',
    enabled: true,
    model: 'claude-sonnet-5',
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
    continueSession: true,
    autoResume: true,
    maxAutoResumes: 3,
    resumePrompt: null,
    completionCheck: 'always',
    completionMarker: null,
    judgeModel: null,
  });

  const goal = goalStore.createGoal({
    promptId: prompt.id,
    name: `Goal ${counter}`,
    description: 'Make the service reliable',
    objectives: goalStore.makeObjectives(objectives),
    status: 'active',
    cadenceMinutes: 0,
    maxIterations: 0,
    stopWhenAchieved: true,
    reviewModel: null,
  });

  return { goal: Object.keys(overrides).length ? goalStore.updateGoal(goal.id, overrides)! : goal, prompt };
}

async function settle(promptId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.listRuns({ promptId, limit: 1 })[0];
    if (run && run.status !== 'queued' && run.status !== 'running') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the iteration never finished');
}

test('an iteration report is read out of the final message', () => {
  const report = parseIterationReport(
    'I looked at the retries.\n\nPROGRESS: Added a backoff to the client and covered it with a test.\n' +
      'DONE: o1, o3\nNEXT: Wire the same backoff into the worker.',
  );
  assert.ok(report);
  assert.match(report.progress, /^Added a backoff/);
  assert.deepEqual(report.achieved, ['o1', 'o3']);
  assert.equal(report.next, 'Wire the same backoff into the worker.');
});

test('a report that closes nothing yields no objectives', () => {
  const report = parseIterationReport('PROGRESS: Read the code.\nDONE: none\nNEXT: none');
  assert.deepEqual(report?.achieved, []);
  assert.equal(report?.next, null);
});

test('text without a report is not mistaken for one', () => {
  assert.equal(parseIterationReport('I had a look around and fixed a typo.'), null);
  assert.equal(parseIterationReport(null), null);
  // Prose is full of these words; only the uppercase labels are the report.
  assert.equal(parseIterationReport('done: cleaned up the retries\nnext: the worker'), null);
  assert.equal(parseIterationReport('PROGRESS:'), null);
});

test('the iteration prompt carries the objectives and what came before', () => {
  const { goal } = makeGoal();
  const text = buildIterationPrompt(goal, [
    {
      id: 'i1',
      goalId: goal.id,
      seq: 1,
      runId: null,
      createdAt: new Date().toISOString(),
      summary: 'Set up the harness',
      nextStep: 'Add the first check',
      achieved: [],
      source: 'report',
      runStatus: 'succeeded',
    },
  ]);

  assert.match(text, /# Goal: /);
  assert.match(text, /\[ \] o1: Ship the thing/);
  assert.match(text, /Set up the harness/);
  assert.match(text, /Add the first check/);
  assert.match(text, /This iteration \(#1\)/);
});

test('a goal iteration runs, is reviewed, and ticks off what it closed', async () => {
  process.env.FAKE_CLAUDE_RESULT =
    'PROGRESS: Shipped it behind a flag.\nDONE: o1\nNEXT: Write the runbook.';
  const { goal, prompt } = makeGoal();

  // First sweep starts the iteration.
  await sweepGoals(new Date());
  const started = runStore.listRuns({ promptId: prompt.id, limit: 1 })[0];
  assert.ok(started, 'an iteration should have been queued');
  assert.match(started.promptText, /Ship the thing/);
  assert.equal(goalStore.getGoal(goal.id)?.iteration, 1);

  await settle(prompt.id);

  // Second sweep reads the report and records the progress.
  await sweepGoals(new Date());
  const [entry] = goalStore.listIterations(goal.id);
  assert.ok(entry);
  assert.equal(entry.source, 'report');
  assert.equal(entry.summary, 'Shipped it behind a flag.');
  assert.equal(entry.nextStep, 'Write the runbook.');
  assert.deepEqual(entry.achieved, ['o1']);

  const after = goalStore.getGoal(goal.id)!;
  assert.equal(after.objectives.find((objective) => objective.id === 'o1')?.done, true);
  assert.equal(after.objectives.find((objective) => objective.id === 'o2')?.done, false);
  // One objective is still open, so the loop keeps going.
  assert.equal(after.status, 'active');
});

test('a goal ends once every objective is ticked', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: Did both halves.\nDONE: o1, o2\nNEXT: nothing left';
  const { goal, prompt } = makeGoal();

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());

  const after = goalStore.getGoal(goal.id)!;
  assert.equal(after.status, 'achieved');
  assert.ok(after.objectives.every((objective) => objective.done));

  // An ended goal starts nothing further, however often the loop comes round.
  const before = runStore.countRuns({ promptId: prompt.id });
  await sweepGoals(new Date());
  assert.equal(runStore.countRuns({ promptId: prompt.id }), before);
});

test('an objective the model invented is not ticked off', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: Wandered off.\nDONE: o9, deploy to prod\nNEXT: focus';
  const { goal, prompt } = makeGoal();

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());

  const after = goalStore.getGoal(goal.id)!;
  assert.deepEqual(goalStore.listIterations(goal.id)[0]?.achieved, []);
  assert.ok(after.objectives.every((objective) => !objective.done));
});

test('the cadence holds the next iteration back', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: A little progress.\nDONE: none\nNEXT: carry on';
  const { goal, prompt } = makeGoal({ cadenceMinutes: 60 });

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 1);

  // An hour later the same sweep starts the next one.
  await sweepGoals(new Date(Date.now() + 61 * 60_000));
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 2);
  assert.equal(goalStore.getGoal(goal.id)?.iteration, 2);
  await settle(prompt.id);
});

test('a goal stops at its iteration limit', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: Still going.\nDONE: none\nNEXT: more';
  const { goal, prompt } = makeGoal({ maxIterations: 1 });

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());

  assert.equal(runStore.countRuns({ promptId: prompt.id }), 1);
  assert.equal(goalStore.getGoal(goal.id)?.status, 'abandoned');
});

test('a paused goal is left alone', async () => {
  const { goal, prompt } = makeGoal({ status: 'paused' });
  await sweepGoals(new Date());
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 0);
  assert.equal(goalStore.getGoal(goal.id)?.status, 'paused');
});

test('repeated failures pause the goal instead of looping on them', async () => {
  process.env.FAKE_CLAUDE_MODE = 'failure';
  const { goal, prompt } = makeGoal();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sweepGoals(new Date());
    await settle(prompt.id);
    await sweepGoals(new Date());
  }

  assert.equal(goalStore.getGoal(goal.id)?.status, 'paused');
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 3);
});
