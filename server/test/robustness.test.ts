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
process.env.MAX_EVENTS_PER_RUN = '50';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate, db } = await import('../src/db.js');
const promptStore = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const goalStore = await import('../src/store/goals.js');
const authStore = await import('../src/store/auth.js');
const mcpStore = await import('../src/store/mcp.js');
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
    repoUrl: null,
    repoRef: null,
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

test('a run a restart interrupted still says how long it had been going', () => {
  const prompt = makePrompt({ name: 'orphan-duration' });
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'manual',
    promptText: 'work',
  });

  // Seven and a half minutes in when the pod went down.
  const startedAt = new Date(Date.now() - 450_500).toISOString();
  runStore.updateRun(run.id, { status: 'running', startedAt });

  assert.ok(runStore.failOrphanedRuns() > 0);

  const interrupted = runStore.getRun(run.id)!;
  assert.equal(interrupted.status, 'failed');
  // Left null this reads as a run that took no time at all — a dash in the
  // list and on the run page, and nothing at all in the dashboard's wall-clock
  // total, which is a SUM that skips nulls. The runs a restart kills are
  // generally the long ones, so that total was missing exactly them.
  assert.ok(interrupted.durationMs !== null, 'the duration should have been worked out, not left null');
  // Computed from started_at, so it is the real elapsed time rather than zero.
  assert.ok(
    Math.abs(interrupted.durationMs - 450_500) < 2_000,
    `expected about 450500ms, got ${interrupted.durationMs}`,
  );
});

test('an objective added while an iteration is being reviewed is not lost', async () => {
  const prompt = makePrompt({ kind: 'goal', name: 'goal-race', completionCheck: 'always' });
  const goal = goalStore.createGoal({
    promptId: prompt.id,
    name: 'Race',
    description: '',
    objectives: goalStore.makeObjectives(['First thing']),
    status: 'active',
    cadenceMinutes: 0,
    maxIterations: 0,
    stopWhenAchieved: false,
    reviewModel: null,
  });

  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'goal',
    promptText: 'work',
  });
  runStore.updateRun(run.id, {
    status: 'succeeded',
    resultText: 'PROGRESS: did the first thing.\nDONE: o1\nNEXT: the next thing',
  });

  // The loop is holding the goal as it read it a moment ago. An iteration takes
  // minutes, and the UI invites you to add objectives while it works.
  const asTheLoopSawIt = goalStore.getGoal(goal.id)!;
  goalStore.updateGoal(goal.id, {
    objectives: [
      ...asTheLoopSawIt.objectives,
      ...goalStore.makeObjectives(['Added while it was thinking'], asTheLoopSawIt.objectives),
    ],
  });

  await reviewIteration(asTheLoopSawIt, runStore.getRun(run.id)!);

  const after = goalStore.getGoal(goal.id)!;
  // Both survive: the tick from the iteration, and the objective a person added
  // in the meantime. Writing back the array the review started from would have
  // erased the second, silently.
  assert.equal(after.objectives.length, 2);
  assert.equal(after.objectives.find((objective) => objective.id === 'o1')?.done, true);
  assert.ok(after.objectives.some((objective) => objective.text === 'Added while it was thinking'));
});

test('deleting an MCP connection stops prompts claiming they still have it', () => {
  const server = mcpStore.createMcpServer({
    name: 'doomed',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://mcp.example/sse' }),
  });
  const user = makePrompt({ mcpServerIds: [server.id] });
  const bystander = makePrompt({ mcpServerIds: [] });

  assert.equal(mcpStore.deleteMcpServer(server.id), true);

  // A run would have skipped the missing connection anyway; the point is that
  // the prompt stops advertising one that no longer exists.
  assert.deepEqual(promptStore.getPrompt(user.id)?.mcpServerIds, []);
  assert.deepEqual(promptStore.getPrompt(bystander.id)?.mcpServerIds, []);
  assert.equal(mcpStore.buildMcpDocument([server.id], null), null);
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

  // The goal also remembers this run as the one the next iteration continues.
  goalStore.recordIterationStart(goal.id, run.id);
  assert.equal(goalStore.getGoal(goal.id)?.lastRunId, run.id);

  // Age it past any retention window and prune.
  db.prepare("UPDATE runs SET queued_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(run.id);
  assert.ok(runStore.pruneOldRuns(30) > 0);

  const [entry] = goalStore.listIterations(goal.id);
  assert.equal(entry?.summary, 'Did something once');
  // The entry survives; the link to a run that no longer exists does not.
  assert.equal(entry?.runId, null);

  // And the pointer the loop actually reads is cleared too. Left dangling, the
  // next iteration would pass it as the run it continues, find no parent, and
  // quietly start a second thread instead of carrying on the first.
  assert.equal(goalStore.getGoal(goal.id)?.lastRunId, null);
});

test('a run whose prompt names a repository starts inside the checkout', async () => {
  const { execFileSync } = await import('node:child_process');
  const gitEnv = {
    ...process.env,
    HOME: tmpDir,
    GIT_AUTHOR_NAME: 'Seed',
    GIT_AUTHOR_EMAIL: 'seed@example.com',
    GIT_COMMITTER_NAME: 'Seed',
    GIT_COMMITTER_EMAIL: 'seed@example.com',
  };
  const remote = path.join(tmpDir, 'repo.git');
  const seed = path.join(tmpDir, 'repo-seed');
  fs.mkdirSync(seed, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { env: gitEnv });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: seed, env: gitEnv });
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: seed, env: gitEnv });
  fs.writeFileSync(path.join(seed, 'PLEASE_FIX.md'), 'the bug is here\n');
  execFileSync('git', ['add', '.'], { cwd: seed, env: gitEnv });
  execFileSync('git', ['commit', '-m', 'seed'], { cwd: seed, env: gitEnv });
  execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: seed, env: gitEnv });

  const prompt = makePrompt({ repoUrl: remote, repoRef: 'main' });
  const run = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;
  await waitFor(() => {
    const status = runStore.getRun(run.id)?.status;
    return status !== 'queued' && status !== 'running';
  });

  // The working directory Claude was started in holds the repository, without
  // the prompt having said a word about cloning.
  const workspace = path.join(tmpDir, 'workspaces', prompt.id);
  assert.ok(fs.existsSync(path.join(workspace, 'PLEASE_FIX.md')), 'the checkout should be there');
  assert.ok(fs.existsSync(path.join(workspace, '.git')));

  // And the run's log says where it came from, so a person reading it later
  // knows which commit the work was done against.
  const prepared = runStore
    .listEvents(run.id)
    .map((event) => event.payload as { kind?: string; ref?: string; head?: string })
    .find((payload) => payload.kind === 'repository');
  assert.equal(prepared?.ref, 'main');
  assert.match(prepared?.head ?? '', /^[0-9a-f]{40}$/);
});

test('a repository that cannot be cloned fails the run instead of running anyway', async () => {
  const prompt = makePrompt({ repoUrl: path.join(tmpDir, 'no-such-repo.git'), repoRef: null });
  const run = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;

  await waitFor(() => runStore.getRun(run.id)?.status === 'failed');
  // Doing the work against an empty directory would look like success and be
  // worse than stopping.
  assert.match(runStore.getRun(run.id)?.error ?? '', /clone failed/);
});

test('running out of turns says which ceiling was hit, not just "failed"', async () => {
  process.env.FAKE_CLAUDE_MODE = 'maxturns';
  const prompt = makePrompt({ maxTurns: 30 });
  const run = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;

  try {
    await waitFor(() => runStore.getRun(run.id)?.status === 'capped');
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }

  const finished = runStore.getRun(run.id)!;
  // The distinction that matters: interrupted by a ceiling, not defeated by the
  // task. Whoever reads this needs to know there is a knob, and which one — and
  // the status carries that too, so a capped run is not filed under failures.
  assert.notEqual(finished.status, 'failed');
  assert.equal(finished.completionReason, 'turn-cap');
  assert.equal(finished.completed, false);
  assert.match(finished.error ?? '', /turn cap of 30/);
  assert.match(finished.error ?? '', /resume/i);
  // Not queued for automatic retry: the same cap would stop it in the same place.
  assert.equal(finished.autoResumePending, false);

  const marked = runStore
    .listEvents(run.id)
    .map((event) => event.payload as { kind?: string; cap?: number })
    .find((payload) => payload.kind === 'turn-cap');
  assert.equal(marked?.cap, 30);
});

test('a queued goal iteration is not counted as queued work on the prompts page', () => {
  const scheduled = makePrompt();
  const goalPrompt = makePrompt({ kind: 'goal', name: 'queued-goal' });

  runStore.createRun({
    promptId: scheduled.id,
    promptName: scheduled.name,
    triggerId: null,
    triggerType: 'cron',
    promptText: 'go',
  });
  runStore.createRun({
    promptId: goalPrompt.id,
    promptName: goalPrompt.name,
    triggerId: null,
    triggerType: 'goal',
    promptText: 'iterate',
  });

  const queued = runStore.countQueuedByKind();
  // A goal owns a hidden prompt. Counting its iteration under `scheduled` is
  // what put "1 queued" above a Prompts page that had nothing to show.
  assert.equal(queued.scheduled, 1);
  assert.equal(queued.goal, 1);
  assert.equal(queued.chat, undefined);
});

test('a chatty run does not grow its event log without bound', () => {
  const prompt = makePrompt();
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'manual',
    promptText: 'go',
  });

  // Well past the configured cap, which this file sets low.
  for (let i = 0; i < 400; i += 1) runStore.appendEvent(run.id, 'message', { i });

  const kept = runStore.listEvents(run.id);
  // Trimming is batched, so the count settles near the cap rather than on it —
  // what matters is that it settles at all rather than growing with the run.
  assert.ok(kept.length <= 50 + 100, `kept ${kept.length} events`);
  assert.ok(kept.length >= 50, `kept ${kept.length} events`);
  // And it is the tail that survives: the end of a run is what anybody reads.
  assert.equal(kept[kept.length - 1]?.seq, 400);
});
