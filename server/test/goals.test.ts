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
const { createPrompt, getPrompt, updatePrompt } = await import('../src/store/prompts.js');
const goalStore = await import('../src/store/goals.js');
const runStore = await import('../src/store/runs.js');
const {
  DEFAULT_ITERATION_INSTRUCTION,
  buildIterationPrompt,
  clearFailureStreak,
  iterationReportInstruction,
  parseIterationReport,
  sweepGoals,
} = await import('../src/goals.js');
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
    iterationInstruction: null,
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

test('a goal out of quota waits for the reset rather than pausing itself', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  // Nothing is going to resume this run, so the loop meets the exhausted case
  // rather than a pause waiting on auto-resume. The fake puts the reset an hour out.
  const { goal, prompt } = makeGoal();
  updatePrompt(prompt.id, { autoResume: false });

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());

  // Running out of credit is a wait, not a fault — pausing would leave the goal
  // stopped long after the allowance came back, with nothing to notice.
  assert.equal(goalStore.getGoal(goal.id)?.status, 'active');

  // And it does not spin at it either, however often the loop comes round.
  for (let attempt = 0; attempt < 3; attempt += 1) await sweepGoals(new Date());
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 1);

  // Once the reset has passed it picks itself back up, unattended.
  delete process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: Back at it.\nDONE: none\nNEXT: carry on';
  await sweepGoals(new Date(Date.now() + 61 * 60_000));
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 2);
  await settle(prompt.id);
});

test('a standing objective is never ticked off, however sincerely the iteration claims it', async () => {
  process.env.FAKE_CLAUDE_RESULT =
    'PROGRESS: Fixed three security holes.\nDONE: o1, o2\nNEXT: keep looking';
  const { goal, prompt } = makeGoal({}, []);
  const standing = goalStore.makeObjectives(['Keep it secure'], [], true);
  const closable = goalStore.makeObjectives(['Write the runbook'], standing);
  goalStore.updateGoal(goal.id, { objectives: [...standing, ...closable] });

  await sweepGoals(new Date());
  await settle(prompt.id);
  await sweepGoals(new Date());

  const after = goalStore.getGoal(goal.id)!;
  const mission = after.objectives.find((objective) => objective.id === 'o1')!;
  assert.equal(mission.continuous, true);
  assert.equal(mission.done, false, 'a standing objective must survive the iteration that claims it');
  // The closable one alongside it still closes, so this is not just "nothing ticks".
  assert.equal(after.objectives.find((objective) => objective.id === 'o2')?.done, true);
  assert.deepEqual(goalStore.listIterations(goal.id)[0]?.achieved, ['o2']);
  // And with a standing objective open, the goal keeps working rather than ending.
  assert.equal(after.status, 'active');
});

test('the iteration prompt marks standing objectives and caps the iteration at one change', () => {
  const { goal } = makeGoal({}, []);
  const updated = goalStore.updateGoal(goal.id, {
    objectives: goalStore.makeObjectives(['Keep it free of bugs'], [], true),
    cadenceMinutes: 30,
  })!;

  const text = buildIterationPrompt(updated, []);
  assert.match(text, /\[~\] o1: Keep it free of bugs \(standing\)/);
  assert.match(text, /never report them under DONE/);
  // The scope rule, and the concrete cost of handing over half-landed work.
  assert.match(text, /The unit of work is \*\*one landed change\*\*/);
  assert.match(text, /Do not start a second change/);
  assert.match(text, /next 30 minutes/);
});

test('a goal whose prompt predates the current report instruction is brought up to date', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: A little.\nDONE: none\nNEXT: more';
  const { prompt } = makeGoal();
  updatePrompt(prompt.id, { appendSystemPrompt: 'an older wording' });

  await sweepGoals(new Date());
  assert.equal(getPrompt(prompt.id)?.appendSystemPrompt, iterationReportInstruction());
  await settle(prompt.id);
});

test('the iteration is told to stop at a handover point, with the budget it has left', () => {
  const { goal } = makeGoal();
  const now = new Date('2026-08-04T10:00:00Z');

  const plenty = buildIterationPrompt(
    goal,
    [],
    { remainingPct: 62, resetsAt: '2026-08-04T13:10:00Z' } as never,
    now,
  );
  assert.match(plenty, /one landed change/);
  assert.match(plenty, /62% of the current token window is still free/);
  assert.match(plenty, /resets in about 3 hours/);
  assert.match(plenty, /not all of it/);

  // Nearly empty reads differently: wind down rather than start something.
  const nearlyOut = buildIterationPrompt(
    goal,
    [],
    { remainingPct: 8, resetsAt: '2026-08-04T10:40:00Z' } as never,
    now,
  );
  assert.match(nearlyOut, /Only 8% of the current token window is left/);
  assert.match(nearlyOut, /resets in about 40 minutes/);
  assert.match(nearlyOut, /Land something small/);

  // With no budget configured there is nothing honest to say about one.
  const unconfigured = buildIterationPrompt(goal, [], { remainingPct: null } as never, now);
  assert.doesNotMatch(unconfigured, /## Budget/);
  assert.doesNotMatch(buildIterationPrompt(goal, []), /## Budget/);
});

test('resuming a paused goal clears the streak that paused it, instead of re-pausing on the next sweep', async () => {
  process.env.FAKE_CLAUDE_MODE = 'failure';
  const { goal, prompt } = makeGoal();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await sweepGoals(new Date());
    await settle(prompt.id);
    await sweepGoals(new Date());
  }
  assert.equal(goalStore.getGoal(goal.id)?.status, 'paused');

  // Resuming without drawing a line under the failures leaves the next sweep
  // counting the very same three, which is what made the button look broken.
  const resumed = goalStore.updateGoal(goal.id, { status: 'active' })!;
  assert.equal(clearFailureStreak(resumed), true);

  delete process.env.FAKE_CLAUDE_MODE;
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: Working again.\nDONE: none\nNEXT: carry on';
  await sweepGoals(new Date());
  assert.equal(goalStore.getGoal(goal.id)?.status, 'active');
  assert.equal(runStore.countRuns({ promptId: prompt.id }), 4, 'it should have started another iteration');
  await settle(prompt.id);

  // A goal with nothing to forgive gets no line in its log for the click.
  assert.equal(clearFailureStreak(goalStore.getGoal(goal.id)!), false);
});

test('a goal that defines its own way of iterating is told that, not the default', () => {
  const { goal } = makeGoal({
    iterationInstruction:
      'Sweep every alert that came in since iteration {{iteration}}, triage each one, and stop ' +
      'when the queue is empty — {{cadence}}',
    cadenceMinutes: 15,
  });

  const text = buildIterationPrompt(goal, []);
  assert.match(text, /Sweep every alert that came in since iteration 1/);
  // The placeholders carry the loop's own numbers into the goal's own words.
  assert.match(text, /next 15 minutes/);
  // And the built-in brief is gone rather than stacked underneath it.
  assert.doesNotMatch(text, /The unit of work is \*\*one landed change\*\*/);
  // As is the sentence in the system prompt that would contradict it.
  assert.match(iterationReportInstruction(goal), /defined in the message you are given/);
  assert.doesNotMatch(iterationReportInstruction(goal), /An iteration is one landed change/);
  // The report contract itself is not the goal's to rewrite: it is what
  // parseIterationReport reads, and a goal that reworded it would hand back
  // something nothing could parse.
  assert.match(iterationReportInstruction(goal), /^PROGRESS:/m);
  assert.match(iterationReportInstruction(goal), /^DONE:/m);
});

test('a goal with no instruction of its own gets the built-in brief', () => {
  const { goal } = makeGoal({ cadenceMinutes: 30 });
  assert.equal(goal.iterationInstruction, null);
  const text = buildIterationPrompt(goal, []);
  assert.match(text, /The unit of work is \*\*one landed change\*\*/);
  assert.match(text, /next 30 minutes/);
  assert.match(iterationReportInstruction(goal), /An iteration is one landed change/);
  // Blank counts as none: an empty editor box means "use the default".
  const blank = goalStore.updateGoal(goal.id, { iterationInstruction: '   ' })!;
  assert.match(buildIterationPrompt(blank, []), /The unit of work is \*\*one landed change\*\*/);
  // The default is the same text the editor is offered as a starting point.
  assert.match(DEFAULT_ITERATION_INSTRUCTION, /one landed change/);
});

test('an unknown placeholder is left alone rather than blanked', () => {
  const { goal } = makeGoal({ iterationInstruction: 'Work on {{whatever}} for {{goal}}.' });
  const text = buildIterationPrompt(goal, []);
  assert.match(text, /Work on \{\{whatever\}\} for Goal \d+\./);
});

test('changing how a goal iterates reaches the next iteration\u2019s system prompt', async () => {
  process.env.FAKE_CLAUDE_RESULT = 'PROGRESS: A little.\nDONE: none\nNEXT: more';
  const { goal, prompt } = makeGoal();

  await sweepGoals(new Date());
  await settle(prompt.id);
  assert.equal(getPrompt(prompt.id)?.appendSystemPrompt, iterationReportInstruction());

  const updated = goalStore.updateGoal(goal.id, { iterationInstruction: 'Review one file.' })!;
  await sweepGoals(new Date());
  assert.equal(getPrompt(prompt.id)?.appendSystemPrompt, iterationReportInstruction(updated));
  await settle(prompt.id);
});
