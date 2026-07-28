import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after, beforeEach } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-cap-test-'));
const recordFile = path.join(tmpDir, 'invocations.jsonl');

process.env.DATA_DIR = tmpDir;
process.env.CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.MAX_CONCURRENT_RUNS = '1';
process.env.FORWARD_ENV_PREFIXES = 'FAKE_';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate } = await import('../src/db.js');
const { createPrompt } = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const { enqueueRun } = await import('../src/queue.js');
const { updateSettings } = await import('../src/store/settings.js');
const { getActiveWindow } = await import('../src/store/usage.js');
import type { Prompt, Run } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_BURN_PER_TURN;
  fs.writeFileSync(recordFile, '');
  updateSettings({ defaultMaxTurns: 30, runTokenCap: 0, budgetBasis: 'weighted' });
});

let counter = 0;
function makePrompt(overrides: Partial<Prompt> = {}): Prompt {
  counter += 1;
  return createPrompt({
    kind: 'scheduled',
    title: null,
    name: `cap-prompt-${counter}`,
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
    autoResume: true,
    maxAutoResumes: 3,
    resumePrompt: null,
    completionCheck: 'always',
    completionMarker: null,
    judgeModel: null,
    ...overrides,
  });
}

async function waitForTerminal(runId: string, timeoutMs = 20_000): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = runStore.getRun(runId)!;
    if (run.status !== 'queued' && run.status !== 'running') return run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`run ${runId} never reached a terminal state`);
}

function argvOf(index = 0): string[] {
  return fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[] })[index]!.argv;
}

test('a prompt with no turn cap of its own inherits the global default', async () => {
  const prompt = makePrompt({ maxTurns: null });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const argv = argvOf();
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '30');
});

test("a prompt's own turn cap wins over the default", async () => {
  const prompt = makePrompt({ maxTurns: 5 });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  const argv = argvOf();
  assert.equal(argv[argv.indexOf('--max-turns') + 1], '5');
});

test('an explicit zero means uncapped, not "fall back to the default"', async () => {
  const prompt = makePrompt({ maxTurns: 0 });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.equal(argvOf().includes('--max-turns'), false);
});

test('the global default can be switched off entirely', async () => {
  updateSettings({ defaultMaxTurns: 0 });
  const prompt = makePrompt({ maxTurns: null });
  await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.equal(argvOf().includes('--max-turns'), false);
});

test('a runaway run is killed once it crosses the per-run ceiling', async () => {
  // 10k input tokens per turn, weighed 1:1, against a 45k ceiling: the run has
  // to die on the fifth turn rather than stream forever.
  updateSettings({ runTokenCap: 45_000 });
  process.env.FAKE_CLAUDE_MODE = 'burn';
  process.env.FAKE_BURN_PER_TURN = '10000';

  const prompt = makePrompt();
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.equal(run.status, 'failed');
  assert.match(run.error ?? '', /per-run ceiling of 45000 tokens/);
  // Terminal on purpose: resuming would spend the whole ceiling again.
  assert.equal(run.autoResumePending, false);
  assert.equal(run.completed, false);
  assert.equal(run.completionReason, 'token-cap');
});

test('spend from a killed run is still charged to the quota window', async () => {
  // The run never emits a `result`, so without the live fallback this usage
  // would disappear and the gauge would under-report exactly when it matters.
  updateSettings({ runTokenCap: 45_000 });
  process.env.FAKE_CLAUDE_MODE = 'burn';
  process.env.FAKE_BURN_PER_TURN = '10000';

  const before = getActiveWindow('session')?.totalTokens ?? 0;
  const prompt = makePrompt();
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);

  assert.ok(run.totalTokens >= 45_000, `expected the run to record its spend, got ${run.totalTokens}`);
  const after = getActiveWindow('session')?.totalTokens ?? 0;
  assert.ok(after >= before + 45_000, `window went from ${before} to ${after}`);
});

test('the ceiling is measured on the configured basis, not the raw sum', async () => {
  // Cache reads weigh 0.1x, so 10k of them per turn is 1k of budget. A 45k
  // ceiling under `weighted` must therefore survive what `total` would kill.
  updateSettings({ runTokenCap: 45_000, budgetBasis: 'weighted' });
  process.env.FAKE_CLAUDE_MODE = 'success';

  const prompt = makePrompt();
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);
  assert.equal(run.status, 'succeeded');
});

test('a ceiling of zero disables the check', async () => {
  updateSettings({ runTokenCap: 0 });
  process.env.FAKE_CLAUDE_MODE = 'success';

  const prompt = makePrompt();
  const run = await waitForTerminal(enqueueRun({ promptId: prompt.id, triggerType: 'manual' })!.id);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.totalTokens, 2000);
});
