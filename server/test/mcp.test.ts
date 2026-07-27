import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-mcp-test-'));
process.env.DATA_DIR = tmpDir;

const { migrate } = await import('../src/db.js');
const { createMcpServer, buildMcpDocument, updateMcpServer } = await import('../src/store/mcp.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test('wraps a bare server entry under its name', () => {
  const server = createMcpServer({
    name: 'kubernetes',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://mcp-k8s.example/sse' }),
  });
  const document = JSON.parse(buildMcpDocument([server.id], null)!);
  assert.deepEqual(document, {
    mcpServers: { kubernetes: { type: 'sse', url: 'https://mcp-k8s.example/sse' } },
  });
});

test('accepts a full .mcp.json document and keeps its own server names', () => {
  const server = createMcpServer({
    name: 'bundle',
    description: '',
    enabled: true,
    config: JSON.stringify({
      mcpServers: {
        github: { command: 'gh-mcp', args: ['serve'] },
        sentry: { type: 'http', url: 'https://sentry.example/mcp' },
      },
    }),
  });
  const document = JSON.parse(buildMcpDocument([server.id], null)!);
  assert.deepEqual(Object.keys(document.mcpServers).sort(), ['github', 'sentry']);
});

test('keeps ${VAR} placeholders intact so secrets stay in the environment', () => {
  const server = createMcpServer({
    name: 'authed',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://x/sse', headers: { Authorization: 'Bearer ${GH_TOKEN}' } }),
  });
  const document = buildMcpDocument([server.id], null)!;
  assert.match(document, /\$\{GH_TOKEN\}/);
  assert.ok(!document.includes('Bearer ghp_'));
});

test('the inline config wins over a shared connection with the same name', () => {
  const server = createMcpServer({
    name: 'overridden',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://shared/sse' }),
  });
  const document = JSON.parse(
    buildMcpDocument([server.id], JSON.stringify({ overridden: { type: 'sse', url: 'https://local/sse' } }))!,
  );
  assert.equal(document.mcpServers.overridden.url, 'https://local/sse');
});

test('a disabled connection is left out', () => {
  const server = createMcpServer({
    name: 'off',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://off/sse' }),
  });
  updateMcpServer(server.id, { enabled: false });
  assert.equal(buildMcpDocument([server.id], null), null);
});

test('no connections and no inline config means no --mcp-config at all', () => {
  assert.equal(buildMcpDocument([], null), null);
  assert.equal(buildMcpDocument([], '   '), null);
});

test('an unparseable stored config is skipped instead of breaking the run', () => {
  const good = createMcpServer({
    name: 'good',
    description: '',
    enabled: true,
    config: JSON.stringify({ type: 'sse', url: 'https://good/sse' }),
  });
  const broken = createMcpServer({
    name: 'broken',
    description: '',
    enabled: true,
    config: '{"type": "sse"',
  });
  const document = JSON.parse(buildMcpDocument([broken.id, good.id], null)!);
  assert.deepEqual(Object.keys(document.mcpServers), ['good']);
});
