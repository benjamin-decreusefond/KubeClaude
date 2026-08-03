import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-agents-test-'));
process.env.DATA_DIR = tmpDir;

const { migrate } = await import('../src/db.js');
const { createAgent, buildAgentsDocument, updateAgent, deleteAgent } = await import('../src/store/agents.js');
const { createPrompt, getPrompt } = await import('../src/store/prompts.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function promptInput(overrides: Partial<Parameters<typeof createPrompt>[0]> = {}) {
  return {
    kind: 'scheduled' as const,
    title: null,
    name: `p-${Math.random().toString(36).slice(2)}`,
    description: '',
    prompt: 'do the thing',
    enabled: true,
    model: null,
    fallbackModel: null,
    effort: null,
    maxBudgetUsd: null,
    workingDir: null,
    addDirs: [],
    repoUrl: null,
    repoRef: null,
    permissionMode: 'default' as const,
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: null,
    systemPrompt: null,
    agentsJson: null,
    agentIds: [],
    builtinTools: null,
    settingSources: null,
    maxTurns: null,
    timeoutSeconds: 1800,
    env: {},
    mcpConfig: null,
    mcpServerIds: [],
    settingsJson: null,
    claudeMd: null,
    continueSession: false,
    autoResume: true,
    maxAutoResumes: 5,
    resumePrompt: null,
    completionCheck: 'marker' as const,
    completionMarker: null,
    judgeModel: null,
    ...overrides,
  };
}

test('wraps a bare agent definition under its name', () => {
  const agent = createAgent({
    name: 'reviewer',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'Reviews a diff', prompt: 'You are a reviewer.' }),
  });
  const document = JSON.parse(buildAgentsDocument([agent.id], null)!);
  assert.deepEqual(document, { reviewer: { description: 'Reviews a diff', prompt: 'You are a reviewer.' } });
});

test('accepts a full { name: {...} } document', () => {
  const agent = createAgent({
    name: 'bundle',
    description: '',
    enabled: true,
    config: JSON.stringify({
      reviewer: { description: 'Reviews', prompt: 'Review it.' },
      tester: { description: 'Tests', prompt: 'Test it.' },
    }),
  });
  const document = JSON.parse(buildAgentsDocument([agent.id], null)!);
  assert.deepEqual(Object.keys(document).sort(), ['reviewer', 'tester']);
});

test('the inline agentsJson wins over a shared agent with the same name', () => {
  const agent = createAgent({
    name: 'overridden',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'shared', prompt: 'shared prompt' }),
  });
  const document = JSON.parse(
    buildAgentsDocument([agent.id], JSON.stringify({ overridden: { description: 'local', prompt: 'local prompt' } }))!,
  );
  assert.equal(document.overridden.description, 'local');
});

test('a disabled agent is left out', () => {
  const agent = createAgent({
    name: 'off',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'x', prompt: 'x' }),
  });
  updateAgent(agent.id, { enabled: false });
  assert.equal(buildAgentsDocument([agent.id], null), null);
});

test('no agents and no inline config means no --agents at all', () => {
  assert.equal(buildAgentsDocument([], null), null);
  assert.equal(buildAgentsDocument([], '   '), null);
});

test('an unparseable stored config is skipped instead of breaking the run', () => {
  const good = createAgent({
    name: 'good',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'x', prompt: 'x' }),
  });
  const broken = createAgent({ name: 'broken', description: '', enabled: true, config: '{"prompt": "x"' });
  const document = JSON.parse(buildAgentsDocument([broken.id, good.id], null)!);
  assert.deepEqual(Object.keys(document), ['good']);
});

test('deleting an agent drops it from any prompt that held it', () => {
  const agent = createAgent({
    name: 'to-delete',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'x', prompt: 'x' }),
  });
  const other = createAgent({
    name: 'kept',
    description: '',
    enabled: true,
    config: JSON.stringify({ description: 'y', prompt: 'y' }),
  });
  const prompt = createPrompt(promptInput({ agentIds: [agent.id, other.id] }));

  assert.ok(deleteAgent(agent.id));

  const reloaded = getPrompt(prompt.id)!;
  assert.deepEqual(reloaded.agentIds, [other.id]);
});
