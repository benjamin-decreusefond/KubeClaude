import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-chat-test-'));
const recordFile = path.join(tmpDir, 'invocations.jsonl');

process.env.DATA_DIR = tmpDir;
process.env.CLAUDE_BIN = path.join(here, 'fixtures', 'fake-claude.mjs');
process.env.FAKE_CLAUDE_RECORD = recordFile;
process.env.FORWARD_ENV_PREFIXES = 'FAKE_';
process.env.MAX_CONCURRENT_RUNS = '1';

fs.chmodSync(process.env.CLAUDE_BIN, 0o755);

const { migrate } = await import('../src/db.js');
const promptStore = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const { enqueueRun } = await import('../src/queue.js');
import type { Prompt, Run } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;
function makeChat(overrides: Partial<Prompt> = {}): Prompt {
  counter += 1;
  return promptStore.createPrompt({
    kind: 'chat',
    name: `chat-${counter}`,
    title: 'Check the media namespace',
    description: '',
    prompt: 'Check the media namespace',
    enabled: true,
    model: null,
    workingDir: null,
    permissionMode: 'bypassPermissions',
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
    autoResume: false,
    maxAutoResumes: 0,
    resumePrompt: null,
    completionCheck: 'never',
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
  throw new Error(`run ${runId} never finished`);
}

function invocations(): Array<{ argv: string[]; stdin: string }> {
  return fs
    .readFileSync(recordFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test('chats are kept out of the scheduled prompt list', () => {
  const before = promptStore.listPrompts().length;
  makeChat();
  assert.equal(promptStore.listPrompts().length, before, 'a chat must not appear under prompts');
  assert.ok(promptStore.listChats().some((chat) => chat.kind === 'chat'));
});

test('a follow-up message resumes the same Claude session', async () => {
  const chat = makeChat();
  fs.writeFileSync(recordFile, '');

  const first = await waitForTerminal(
    enqueueRun({ promptId: chat.id, triggerType: 'chat', promptText: 'Check the media namespace' })!.id,
  );
  assert.equal(first.status, 'succeeded');
  assert.ok(first.sessionId);

  const second = enqueueRun({
    promptId: chat.id,
    triggerType: 'chat',
    promptText: 'Now restart the deployment',
    followUpText: 'Now restart the deployment',
    resumeOfRunId: first.id,
    sessionId: first.sessionId,
  })!;
  await waitForTerminal(second.id);

  const calls = invocations();
  assert.equal(calls.length, 2);
  // The opening message starts fresh...
  assert.ok(!calls[0]!.argv.includes('--resume'));
  assert.equal(calls[0]!.stdin.trim(), 'Check the media namespace');
  // ...and the reply carries the conversation forward.
  assert.ok(calls[1]!.argv.includes('--resume'));
  assert.equal(calls[1]!.argv[calls[1]!.argv.indexOf('--resume') + 1], first.sessionId);
  assert.equal(calls[1]!.stdin.trim(), 'Now restart the deployment');
});

test('every message in a chat lands in one thread', async () => {
  const chat = makeChat();
  const first = await waitForTerminal(
    enqueueRun({ promptId: chat.id, triggerType: 'chat', promptText: 'one' })!.id,
  );
  const second = await waitForTerminal(
    enqueueRun({
      promptId: chat.id,
      triggerType: 'chat',
      promptText: 'two',
      followUpText: 'two',
      resumeOfRunId: first.id,
      sessionId: first.sessionId,
    })!.id,
  );

  const thread = runStore.listThread(second.id);
  assert.equal(thread.length, 2);
  assert.equal(thread[0]!.rootRunId, first.id);
  assert.equal(thread[1]!.rootRunId, first.id);
  assert.equal(thread[1]!.followUpText, 'two');
});

test('a chat carries its permission mode and tools into the run', async () => {
  const chat = makeChat({ permissionMode: 'bypassPermissions', allowedTools: ['Bash(kubectl:*)'] });
  fs.writeFileSync(recordFile, '');
  await waitForTerminal(enqueueRun({ promptId: chat.id, triggerType: 'chat' })!.id);

  const [call] = invocations();
  assert.equal(call!.argv[call!.argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
  assert.equal(call!.argv[call!.argv.indexOf('--allowed-tools') + 1], 'Bash(kubectl:*)');
});

test('a quota stop in a chat is not auto-resumed behind the user’s back', async () => {
  process.env.FAKE_CLAUDE_MODE = 'ratelimit';
  const chat = makeChat({ autoResume: false, completionCheck: 'never' });
  const run = await waitForTerminal(enqueueRun({ promptId: chat.id, triggerType: 'chat' })!.id);

  assert.equal(run.status, 'rate_limited');
  // A person is sitting there; silently continuing hours later is not wanted.
  assert.equal(run.autoResumePending, false);
  delete process.env.FAKE_CLAUDE_MODE;
});

test('deleting a chat removes its runs', () => {
  const chat = makeChat();
  const run = enqueueRun({ promptId: chat.id, triggerType: 'chat' })!;
  assert.ok(runStore.getRun(run.id));
  promptStore.deletePrompt(chat.id);
  assert.equal(runStore.getRun(run.id), null);
});
