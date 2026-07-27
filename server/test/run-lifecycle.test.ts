import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after, beforeEach } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-run-test-'));
const recordFile = path.join(tmpDir, 'invocations.jsonl');

process.env.DATA_DIR = tmpDir;
process.env.CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.MAX_CONCURRENT_RUNS = '1';
// Runs get a strict env allowlist, so the fixture's own knobs must be opted in.
process.env.FORWARD_ENV_PREFIXES = 'FAKE_';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate } = await import('../src/db.js');
const { createPrompt } = await import('../src/store/prompts.js');
const { createMcpServer } = await import('../src/store/mcp.js');
const runStore = await import('../src/store/runs.js');
const { getActiveWindow } = await import('../src/store/usage.js');
const { enqueueRun } = await import('../src/queue.js');
const { sweepAutoResumes } = await import('../src/scheduler.js');
import type { Prompt, Run } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  fs.writeFileSync(recordFile, '');
});

let counter = 0;
function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  counter += 1;
  return createPrompt({
    name: `prompt-${counter}`,
    description: '',
    prompt: 'Review the open PRs and merge the green ones',
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
    continueSession: false,
    autoResume: true,
    maxAutoResumes: 3,
    resumePrompt: null,
    // Most tests care about the resume path, so default to "always unfinished".
    completionCheck: 'always',
    completionMarker: null,
    judgeModel: null,
    ...overrides,
  });
}

async function waitForTerminal(runId: string, timeoutMs = 15_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.getRun(runId)!;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached a terminal state`);
}

function invocations(): Array<{ argv: string[]; stdin: string; cwd: string }> {
  return fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('a successful run records its result, usage and model', async () => {
  const prompt = makePrompt();
  const queued = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;
  const run = await waitForTerminal(queued.id);

  assert.equal(run.status, 'succeeded');
  assert.equal(run.sessionId, 'session-abc');
  assert.match(run.resultText ?? '', /^done: Review the open PRs/);
  assert.equal(run.inputTokens, 1000);
  assert.equal(run.outputTokens, 500);
  assert.equal(run.totalTokens, 2000);
  assert.equal(run.costUsd, 0.05);
  assert.equal(run.numTurns, 3);
  assert.equal(run.model, 'claude-sonnet-5');
  assert.equal(run.durationApiMs, 3100);
  assert.equal(run.serviceTier, 'standard');
  assert.deepEqual(Object.keys(run.modelUsage ?? {}), ['claude-sonnet-5']);
  // The run is its own thread root until something continues it.
  assert.equal(run.rootRunId, run.id);
});

test('the prompt text goes over stdin and the model flag is passed', async () => {
  const prompt = makePrompt({ model: 'claude-opus-5' });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const [call] = invocations();
  assert.ok(call);
  assert.equal(call.stdin.trim(), 'Review the open PRs and merge the green ones');
  assert.ok(call.argv.includes('--model'));
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'claude-opus-5');
  assert.ok(call.argv.includes('--print'));
  assert.ok(call.argv.includes('stream-json'));
  // No MCP connections attached, so no config flag.
  assert.ok(!call.argv.includes('--mcp-config'));
});

test('attached MCP connections are written to a config file for the run', async () => {
  const server = createMcpServer({
    name: 'k8s',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://mcp-k8s.example/sse' }),
  });
  const prompt = makePrompt({ mcpServerIds: [server.id] });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const [call] = invocations();
  assert.ok(call?.argv.includes('--mcp-config'));
  assert.ok(call?.argv.includes('--strict-mcp-config'));
});

test('usage lands in the open 5h and weekly windows', async () => {
  const before = getActiveWindow('session')?.totalTokens ?? 0;
  const prompt = makePrompt();
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const session = getActiveWindow('session');
  const weekly = getActiveWindow('weekly');
  assert.equal(session?.totalTokens, before + 2000);
  assert.ok((weekly?.totalTokens ?? 0) >= 2000);
});

test('a plain failure is reported as failed, not parked for resume', async () => {
  process.env.FAKE_CLAUDE_MODE = 'failure';
  const prompt = makePrompt();
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.equal(run.status, 'failed');
  assert.equal(run.autoResumePending, false);
  assert.match(run.error ?? '', /Something went wrong/);
});

test('hitting the quota parks the run and the sweep resumes its session', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  process.env.FAKE_RESET_EPOCH = String(Math.floor(Date.now() / 1000) - 600); // reset already elapsed, past the resume delay
  const prompt = makePrompt();
  const limited = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'cron' })!.id);

  assert.equal(limited.status, 'rate_limited');
  assert.equal(limited.autoResumePending, true);
  assert.equal(limited.sessionId, 'session-abc');
  assert.ok(limited.rateLimitResetAt);

  // Quota is back; the sweep should continue the same session rather than restart.
  delete process.env.FAKE_CLAUDE_MODE;
  fs.writeFileSync(recordFile, '');
  sweepAutoResumes(new Date());

  const thread = runStore.listThread(limited.id);
  assert.equal(thread.length, 2);
  const resumed = thread[1]!;
  assert.equal(resumed.resumeOfRunId, limited.id);
  assert.equal(resumed.rootRunId, limited.rootRunId);
  assert.equal(resumed.resumeAttempt, 1);
  assert.equal(runStore.getRun(limited.id)!.autoResumePending, false);

  await waitForTerminal(resumed.id);
  const [call] = invocations();
  assert.ok(call?.argv.includes('--resume'), 'the resumed run must pass --resume');
  assert.equal(call?.argv[call.argv.indexOf('--resume') + 1], 'session-abc');
  assert.match(call?.stdin ?? '', /Continue the task from exactly where it left off/);

  delete process.env.FAKE_RESET_EPOCH;
});

test('auto-resume stops after the configured number of attempts', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  process.env.FAKE_RESET_EPOCH = String(Math.floor(Date.now() / 1000) - 600);
  const prompt = makePrompt({ maxAutoResumes: 1 });

  const first = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'cron' })!.id);
  assert.equal(first.autoResumePending, true);

  sweepAutoResumes(new Date());
  const second = runStore.listThread(first.id)[1]!;
  const secondDone = await waitForTerminal(second.id);
  assert.equal(secondDone.resumeAttempt, 1);
  // Attempt 1 of a maximum of 1: no further resume may be queued.
  assert.equal(secondDone.autoResumePending, false);

  sweepAutoResumes(new Date());
  assert.equal(runStore.listThread(first.id).length, 2);

  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_RESET_EPOCH;
});

test('a run that stops on quota is left alone when auto-resume is off', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  const prompt = makePrompt({ autoResume: false });
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.equal(run.status, 'rate_limited');
  assert.equal(run.autoResumePending, false);

  sweepAutoResumes(new Date());
  assert.equal(runStore.listThread(run.id).length, 1);
  delete process.env.FAKE_CLAUDE_MODE;
});

test('a follow-up continues the conversation in the same thread', async () => {
  const prompt = makePrompt();
  const first = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);
  fs.writeFileSync(recordFile, '');

  const followUp = enqueueRun({
    promptId: prompt.id,
    triggerType: 'follow_up',
    promptText: 'Also update the changelog',
    followUpText: 'Also update the changelog',
    resumeOfRunId: first.id,
    sessionId: first.sessionId,
  })!;
  await waitForTerminal(followUp.id);

  const thread = runStore.listThread(first.id);
  assert.equal(thread.length, 2);
  assert.equal(thread[1]!.followUpText, 'Also update the changelog');
  assert.equal(thread[1]!.rootRunId, first.id);

  const [call] = invocations();
  assert.ok(call?.argv.includes('--resume'));
  assert.equal(call?.stdin.trim(), 'Also update the changelog');
});

test('a finished task is not resumed even though the quota ran out', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  process.env.FAKE_RESET_EPOCH = String(Math.floor(Date.now() / 1000) - 600);
  process.env.FAKE_CLAUDE_MARKER = 'KUBECLAUDE_TASK_COMPLETE';
  const prompt = makePrompt({ completionCheck: 'marker' });

  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'cron' })!.id);
  assert.equal(run.status, 'rate_limited');
  assert.equal(run.completed, true);
  assert.match(run.completionReason ?? '', /completion marker/);
  assert.equal(run.autoResumePending, false);

  sweepAutoResumes(new Date());
  assert.equal(runStore.listThread(run.id).length, 1, 'a completed task must not be resumed');

  delete process.env.FAKE_CLAUDE_MARKER;
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_RESET_EPOCH;
});

test('an unfinished task is resumed when the marker is absent', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  process.env.FAKE_RESET_EPOCH = String(Math.floor(Date.now() / 1000) - 600);
  const prompt = makePrompt({ completionCheck: 'marker' });

  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'cron' })!.id);
  assert.equal(run.completed, false);
  assert.match(run.completionReason ?? '', /No KUBECLAUDE_TASK_COMPLETE line/);
  assert.equal(run.autoResumePending, true);

  delete process.env.FAKE_CLAUDE_MODE;
  sweepAutoResumes(new Date());
  const thread = runStore.listThread(run.id);
  assert.equal(thread.length, 2);
  // Let the resumed run finish so it cannot bleed into the next test.
  await waitForTerminal(thread[1]!.id);

  delete process.env.FAKE_RESET_EPOCH;
});

test('marker mode tells the model how to announce completion', async () => {
  const prompt = makePrompt({ completionCheck: 'marker', completionMarker: 'ALL_DONE' });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const [call] = invocations();
  const index = call!.argv.indexOf('--append-system-prompt');
  assert.notEqual(index, -1);
  assert.match(call!.argv[index + 1]!, /output the exact line ALL_DONE/);
});

test('a run that never returns is killed at its timeout', async () => {
  process.env.FAKE_CLAUDE_MODE = 'hang';
  const prompt = makePrompt({ timeoutSeconds: 30 }); // clamped to the 30s minimum
  const queued = enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!;
  const run = await waitForTerminal(queued.id, 45_000);

  assert.equal(run.status, 'timeout');
  assert.match(run.error ?? '', /Timed out/);
  delete process.env.FAKE_CLAUDE_MODE;
});
