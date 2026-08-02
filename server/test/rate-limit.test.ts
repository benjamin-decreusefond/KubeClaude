import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRateLimit } from '../src/claude/rate-limit.js';

test('detects the CLI machine-readable usage limit with an epoch reset', () => {
  const info = detectRateLimit('Claude AI usage limit reached|1751808000');
  assert.equal(info.limited, true);
  assert.equal(info.scope, 'session');
  assert.equal(info.resetAt, new Date(1751808000 * 1000).toISOString());
});

test('detects a weekly limit and keeps the scope', () => {
  const info = detectRateLimit('You have reached your weekly limit reached for Claude Code');
  assert.equal(info.limited, true);
  assert.equal(info.scope, 'weekly');
});

test('detects a 5-hour session limit', () => {
  const info = detectRateLimit(null, '5-hour limit reached, resets at 2026-07-27T18:00:00Z');
  assert.equal(info.limited, true);
  assert.equal(info.scope, 'session');
  assert.equal(info.resetAt, '2026-07-27T18:00:00.000Z');
});

test('detects an API rate_limit_error', () => {
  assert.equal(detectRateLimit('{"type":"rate_limit_error"}').limited, true);
});

test('leaves ordinary failures alone', () => {
  assert.equal(detectRateLimit('Error: file not found').limited, false);
  assert.equal(detectRateLimit('').limited, false);
  assert.equal(detectRateLimit(undefined, null).limited, false);
});

test('does not treat a discussion of limits in output as a limit hit', () => {
  // "limit" alone must not match; only the specific phrasings do.
  assert.equal(detectRateLimit('I set a limit of 5 retries in the config').limited, false);
});

test('a reset that looks like a date but is not one leaves the limit readable', () => {
  // The pattern matches the shape, not a real date. Parsing this and calling
  // toISOString() throws, and the throw would turn a quota stop into a plain
  // failure — losing the automatic resume that is the whole point of detecting
  // it. A date we cannot read is simply no date.
  const info = detectRateLimit('weekly limit reached, resets at 2026-13-45T99:99');
  assert.equal(info.limited, true);
  assert.equal(info.scope, 'weekly');
  assert.equal(info.resetAt, null);
});
