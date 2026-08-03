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
const { updateSettings } = await import('../src/store/settings.js');
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
    kind: 'scheduled',
    title: null,
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
  // The label names the original trigger once, however many resumes deep it is.
  assert.equal(resumed.triggerType, 'auto_resume:cron');
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

test('the environment briefing reaches every run, ahead of the prompt’s own instructions', async () => {
  updateSettings({ environmentBriefing: 'BRIEFING: you are in a cluster.' });
  const prompt = makePrompt({ appendSystemPrompt: 'PROMPT_RULE: only touch media/.' });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const [call] = invocations();
  const system = call!.argv[call!.argv.indexOf('--append-system-prompt') + 1]!;
  assert.ok(system.includes('BRIEFING: you are in a cluster.'));
  assert.ok(system.includes('PROMPT_RULE: only touch media/.'));
  assert.ok(
    system.indexOf('BRIEFING') < system.indexOf('PROMPT_RULE'),
    'the briefing must come first, so the prompt can narrow it',
  );
});

test('an empty briefing contributes nothing of its own, but the probe still goes', async () => {
  updateSettings({ environmentBriefing: '' });
  const prompt = makePrompt();
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  // Clearing the briefing says "do not tell runs about my platform". It does not
  // say "hide which tools exist" — that is not an opinion, it is the container,
  // and a run that has to discover it by trial spends a session doing so.
  const { argv } = invocations()[0]!;
  const system = argv[argv.indexOf('--append-system-prompt') + 1]!;
  assert.match(system, /What this image actually has/);
  assert.match(system, /no root/i);
  // Nothing of the operator's own text, since there is none.
  assert.equal(system.startsWith('# What this image actually has'), true);
});

test('kubectl can find the cluster from inside a run', async () => {
  process.env.KUBERNETES_SERVICE_HOST = '10.43.0.1';
  process.env.KUBERNETES_SERVICE_PORT = '443';
  const prompt = makePrompt();
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  // The runner reports the env keys it handed to the CLI.
  const events = runStore
    .listEvents(runStore.listRuns({ promptId: prompt.id, limit: 1 })[0]!.id)
    .filter((e) => e.kind === 'system');
  const invocation = events.find(
    (e) => (e.payload as Record<string, unknown>).kind === 'invocation',
  )!.payload as { envKeys: string[] };
  assert.ok(invocation.envKeys.includes('KUBERNETES_SERVICE_HOST'));
  assert.ok(invocation.envKeys.includes('KUBERNETES_SERVICE_PORT'));

  delete process.env.KUBERNETES_SERVICE_HOST;
  delete process.env.KUBERNETES_SERVICE_PORT;
});

test('a repo’s own CLAUDE.md is never overwritten', async () => {
  const repo = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  const target = path.join(repo, 'CLAUDE.md');
  fs.writeFileSync(target, '# The repository’s own conventions\nDo not lose me.', 'utf8');

  const prompt = makePrompt({ workingDir: repo, claudeMd: 'KubeClaude standing context' });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  // The checkout is intact...
  assert.match(fs.readFileSync(target, 'utf8'), /Do not lose me\./);
  // ...and the content was delivered the other way instead.
  const [call] = invocations();
  const system = call!.argv[call!.argv.indexOf('--append-system-prompt') + 1]!;
  assert.ok(system.includes('KubeClaude standing context'));
});

test('a CLAUDE.md KubeClaude wrote is replaced on the next run', async () => {
  const workspace = fs.mkdtempSync(path.join(tmpDir, 'ws-'));
  const target = path.join(workspace, 'CLAUDE.md');

  const first = makePrompt({ workingDir: workspace, claudeMd: 'first version' });
  await waitForTerminal(enqueueRun({ promptId: first.id, triggerType: 'manual' })!.id);
  assert.match(fs.readFileSync(target, 'utf8'), /first version/);

  const second = makePrompt({ workingDir: workspace, claudeMd: 'second version' });
  await waitForTerminal(enqueueRun({ promptId: second.id, triggerType: 'manual' })!.id);
  const content = fs.readFileSync(target, 'utf8');
  assert.match(content, /second version/);
  assert.ok(!content.includes('first version'));
});

test('the execution controls a prompt sets reach the CLI', async () => {
  const prompt = makePrompt({
    model: 'claude-opus-5',
    fallbackModel: 'sonnet,haiku',
    effort: 'high',
    maxBudgetUsd: 2.5,
    addDirs: ['/tmp/one', '/tmp/two'],
    permissionMode: 'auto',
  });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const { argv } = invocations()[0]!;
  assert.equal(argv[argv.indexOf('--fallback-model') + 1], 'sonnet,haiku');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'high');
  assert.equal(argv[argv.indexOf('--max-budget-usd') + 1], '2.5');
  assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'auto');
  // --add-dir is variadic: the flag once, then every directory.
  const dirs = argv.indexOf('--add-dir');
  assert.deepEqual(argv.slice(dirs + 1, dirs + 3), ['/tmp/one', '/tmp/two']);
});

test('a prompt with no model preferences inherits the global ones', async () => {
  updateSettings({ defaultFallbackModel: 'haiku', defaultEffort: 'low' });
  try {
    await waitForTerminal(enqueueRun({ promptId: makePrompt().id, triggerType: 'manual' })!.id);
    const first = invocations()[0]!.argv;
    assert.equal(first[first.indexOf('--fallback-model') + 1], 'haiku');
    assert.equal(first[first.indexOf('--effort') + 1], 'low');

    // What the prompt names for itself wins over the global default.
    const pinned = makePrompt({ fallbackModel: 'sonnet', effort: 'max' });
    await waitForTerminal(enqueueRun({ promptId: pinned.id, triggerType: 'manual' })!.id);
    const second = invocations()[1]!.argv;
    assert.equal(second[second.indexOf('--fallback-model') + 1], 'sonnet');
    assert.equal(second[second.indexOf('--effort') + 1], 'max');
  } finally {
    updateSettings({ defaultFallbackModel: null, defaultEffort: null });
  }
});

test('what a run is made of reaches the CLI too', async () => {
  const agents = JSON.stringify({ reviewer: { description: 'Reviews code', prompt: 'You review' } });
  const prompt = makePrompt({
    systemPrompt: 'You are a release engineer.',
    agentsJson: agents,
    builtinTools: ['Bash', 'Read'],
    settingSources: 'user',
    appendSystemPrompt: 'Only ever touch the media directory.',
  });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const { argv } = invocations()[0]!;
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], 'You are a release engineer.');
  assert.equal(argv[argv.indexOf('--agents') + 1], agents);
  assert.equal(argv[argv.indexOf('--tools') + 1], 'Bash,Read');
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], 'user');
  // Replacing the system prompt does not throw away what KubeClaude appends:
  // both flags travel together, and the prompt's own instruction survives —
  // alongside the capability probe, which is about the container rather than
  // about the task and so is not the prompt's to replace.
  const system = argv[argv.indexOf('--append-system-prompt') + 1]!;
  assert.match(system, /Only ever touch the media directory\./);
  assert.match(system, /What this image actually has/);
});

test('an empty tool set and "no settings files" are passed, not skipped', async () => {
  const prompt = makePrompt({ builtinTools: [], settingSources: 'none' });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const { argv } = invocations()[0]!;
  // An empty list is a decision — no built-in tools — not an absent value.
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  // 'none' is our spelling of "read nothing"; the CLI's is an empty string.
  assert.equal(argv[argv.indexOf('--setting-sources') + 1], '');
});

test('a prompt left alone keeps the CLI defaults for all of it', async () => {
  await waitForTerminal(enqueueRun({ promptId: makePrompt().id, triggerType: 'manual' })!.id);
  const { argv } = invocations()[0]!;
  for (const flag of ['--system-prompt', '--agents', '--tools', '--setting-sources']) {
    assert.ok(!argv.includes(flag), `${flag} must not be passed when nothing asked for it`);
  }
});

test('a prompt that sets none of them passes none of the flags', async () => {
  await waitForTerminal(enqueueRun({ promptId: makePrompt().id, triggerType: 'manual' })!.id);
  const { argv } = invocations()[0]!;
  for (const flag of ['--fallback-model', '--effort', '--max-budget-usd', '--add-dir']) {
    assert.ok(!argv.includes(flag), `${flag} must not be passed when nothing asked for it`);
  }
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
