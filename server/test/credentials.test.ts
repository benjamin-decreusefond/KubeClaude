import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, afterEach } from 'node:test';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-creds-'));

const { claudeCredentials, billingMode, shadowedCredentials, hasCredentials } = await import(
  '../src/config.js'
);

const KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

function only(set: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, set);
}

afterEach(() => only({}));

test('a subscription token is forwarded alone', () => {
  only({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' });
  assert.deepEqual(claudeCredentials(), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' });
  assert.equal(billingMode(), 'subscription');
  assert.equal(hasCredentials(), true);
});

test('an API key alone means per-token billing', () => {
  only({ ANTHROPIC_API_KEY: 'sk-ant-api-x' });
  assert.deepEqual(claudeCredentials(), { ANTHROPIC_API_KEY: 'sk-ant-api-x' });
  assert.equal(billingMode(), 'api');
});

test('the subscription wins when both are set, and the key is reported as ignored', () => {
  // The whole point: nobody should have to guess which credential is paying.
  only({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x', ANTHROPIC_API_KEY: 'sk-ant-api-x' });
  assert.deepEqual(claudeCredentials(), { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x' });
  assert.equal(billingMode(), 'subscription');
  assert.deepEqual(shadowedCredentials(), ['ANTHROPIC_API_KEY']);
});

test('a gateway takes precedence over both, since a base URL is only set deliberately', () => {
  only({
    ANTHROPIC_BASE_URL: 'https://gw.internal',
    ANTHROPIC_AUTH_TOKEN: 'gw-token',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-x',
  });
  const env = claudeCredentials();
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.internal');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'gw-token');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(billingMode(), 'gateway');
  assert.deepEqual(shadowedCredentials(), ['CLAUDE_CODE_OAUTH_TOKEN']);
});

test('no credentials is reported as such rather than guessed at', () => {
  only({});
  assert.deepEqual(claudeCredentials(), {});
  assert.equal(billingMode(), 'none');
  assert.equal(hasCredentials(), false);
  assert.deepEqual(shadowedCredentials(), []);
});
