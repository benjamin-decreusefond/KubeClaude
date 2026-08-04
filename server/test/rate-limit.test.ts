import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectRateLimit, detectRateLimitAt } from '../src/claude/rate-limit.js';

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

test('detects the wall-clock form the CLI actually prints, and reads the reset out of it', () => {
  // Verbatim from a goal iteration that was filed as a plain failure instead:
  // no "reached", and a local time with a zone rather than a timestamp.
  const now = new Date('2026-08-04T09:00:00Z');
  const info = detectRateLimitAt(
    now,
    "You've hit your session limit · resets 3:10pm (Europe/Paris)",
  );
  assert.equal(info.limited, true);
  assert.equal(info.scope, 'session');
  // 15:10 in Paris is 13:10 UTC in August, and it is still ahead of us.
  assert.equal(info.resetAt, '2026-08-04T13:10:00.000Z');
});

test('a reset time already past today is tomorrow’s', () => {
  const info = detectRateLimitAt(
    new Date('2026-08-04T20:00:00Z'),
    "You've hit your session limit · resets 3:10pm (Europe/Paris)",
  );
  assert.equal(info.resetAt, '2026-08-05T13:10:00.000Z');
});

test('a 24-hour clock and a zone are read the same way', () => {
  const info = detectRateLimitAt(
    new Date('2026-08-04T09:00:00Z'),
    'Weekly limit reached · resets at 06:00 (UTC)',
  );
  assert.equal(info.scope, 'weekly');
  assert.equal(info.resetAt, '2026-08-05T06:00:00.000Z');
});

test('a reset with no zone, or an unknown one, is simply no reset', () => {
  const now = new Date('2026-08-04T09:00:00Z');
  assert.equal(detectRateLimitAt(now, 'Session limit hit, resets 3:10pm').resetAt, null);
  assert.equal(detectRateLimitAt(now, 'Session limit hit, resets 3:10pm (Mars/Olympus)').resetAt, null);
  // Still a rate limit, though — the reset is a bonus, not the signal.
  assert.equal(detectRateLimitAt(now, 'Session limit hit, resets 3:10pm').limited, true);
});
