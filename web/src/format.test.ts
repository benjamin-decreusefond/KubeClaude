import { describe, expect, test } from 'vitest';
import {
  formatCost,
  formatDuration,
  formatPct,
  formatRelative,
  formatTokens,
  triggerLabel,
} from './format';

describe('formatTokens', () => {
  test('stays exact below a thousand and compacts above it', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(912)).toBe('912');
    expect(formatTokens(1_200)).toBe('1.2k');
    // Past ten thousand the decimal is noise, so it goes.
    expect(formatTokens(48_300)).toBe('48k');
    expect(formatTokens(1_200_000)).toBe('1.2M');
    expect(formatTokens(12_000_000)).toBe('12M');
  });

  test('survives what a missing usage report actually looks like', () => {
    expect(formatTokens(Number.NaN)).toBe('0');
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('formatCost', () => {
  test('distinguishes free, nearly free, and worth knowing', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost(0)).toBe('$0.00');
    // A run that cost a fraction of a cent should not read as free.
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1.5)).toBe('$1.50');
    expect(formatCost(120.4)).toBe('$120');
  });
});

describe('formatDuration', () => {
  test('reads in the unit that matters at that scale', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(4_200)).toBe('4s');
    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(formatDuration(3 * 3_600_000 + 25 * 60_000)).toBe('3h 25m');
  });
});

describe('formatRelative', () => {
  const now = new Date('2026-07-31T12:00:00Z').getTime();

  test('says which side of now it is on', () => {
    expect(formatRelative('2026-07-31T11:59:30Z', now)).toBe('30s ago');
    expect(formatRelative('2026-07-31T12:05:00Z', now)).toBe('in 5m');
    expect(formatRelative('2026-07-31T09:46:00Z', now)).toBe('2h 14m ago');
    expect(formatRelative('2026-08-03T14:00:00Z', now)).toBe('in 3d 2h');
  });

  test('an absent or unparseable timestamp is a dash, not "NaN ago"', () => {
    expect(formatRelative(null, now)).toBe('—');
    expect(formatRelative('not a date', now)).toBe('—');
  });
});

describe('triggerLabel', () => {
  test('names the trigger types and unwraps continuations', () => {
    expect(triggerLabel('session_reset')).toBe('New 5h session');
    expect(triggerLabel('quota_available')).toBe('Tokens available');
    expect(triggerLabel('auto_resume:cron')).toBe('Auto-resume');
    expect(triggerLabel('manual_resume:interval')).toBe('Manual resume');
    // Anything unknown is shown as-is rather than hidden behind "Unknown".
    expect(triggerLabel('goal:manual')).toBe('goal:manual');
  });
});

describe('formatPct', () => {
  test('rounds and handles the unknown case', () => {
    expect(formatPct(42.4)).toBe('42%');
    expect(formatPct(null)).toBe('—');
  });
});
