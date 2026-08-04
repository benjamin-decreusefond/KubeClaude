export interface RateLimitInfo {
  limited: boolean;
  /** ISO timestamp when the quota is expected back, when Claude tells us. */
  resetAt: string | null;
  /** Which allowance ran out, when it can be told apart. */
  scope: 'session' | 'weekly' | 'unknown';
  /** The snippet that matched, for display in the UI. */
  evidence: string | null;
}

const NOT_LIMITED: RateLimitInfo = { limited: false, resetAt: null, scope: 'unknown', evidence: null };

/**
 * `Claude AI usage limit reached|1751808000` — the CLI's machine-readable form,
 * where the trailing number is a Unix timestamp (seconds) for the reset.
 */
const USAGE_LIMIT_WITH_EPOCH = /usage limit reached\s*\|\s*(\d{9,13})/i;

/**
 * These deliberately do not require the word "reached". The CLI says
 * `You've hit your session limit · resets 3:10pm (Europe/Paris)`, and a
 * pattern that insisted on "session limit reached" let that through as a plain
 * failure — which costs the run its automatic resume and, for a goal, counts
 * as one of the three strikes that pause it. "session limit" and "weekly
 * limit" are specific enough on their own.
 */
const LIMIT_PATTERNS: Array<{ re: RegExp; scope: RateLimitInfo['scope'] }> = [
  { re: /\b5[-\s]?hour limit\b/i, scope: 'session' },
  { re: /\bsession limit\b/i, scope: 'session' },
  { re: /\bweekly limit\b/i, scope: 'weekly' },
  { re: /\bweekly usage limit/i, scope: 'weekly' },
  { re: /usage limit reached/i, scope: 'unknown' },
  { re: /\brate[_\s]?limit(_error)?\b/i, scope: 'unknown' },
  { re: /\bquota exceeded\b/i, scope: 'unknown' },
  { re: /\bout of (?:usage|tokens|credits)\b/i, scope: 'unknown' },
  { re: /\b429\b.*\b(too many requests|rate)\b/i, scope: 'unknown' },
  // "hit your limit", "reached your usage limit", "hit your Claude Code limit".
  { re: /\byou(?:'ve| have) (?:hit|reached) your (?:\w+ ){0,3}limit\b/i, scope: 'unknown' },
];

/** `Your limit will reset at 3pm` / `resets at 2026-07-27T18:00:00Z`. */
const RESET_ISO = /reset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i;

/**
 * The human form the CLI actually prints: `resets 3:10pm (Europe/Paris)`, or
 * `resets at 15:10 (Europe/Paris)`. The zone is what makes it readable at all —
 * a wall-clock time with no zone could be anywhere in a 26-hour spread, so
 * without one this is left unparsed rather than guessed.
 */
const RESET_CLOCK = /reset(?:s|ting)?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)\n]{1,60})\)/i;

/**
 * Minutes `zone` is ahead of UTC at `at`. Works by formatting the instant in
 * that zone and reading the wall-clock back as if it were UTC — the difference
 * between the two is the offset, DST included.
 */
function zoneOffsetMinutes(zone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(at);
    const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    // `hour12: false` renders midnight as 24 in some engines.
    const hour = field('hour') % 24;
    const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), hour, field('minute'), field('second'));
    return Math.round((asUtc - at.getTime()) / 60_000);
  } catch {
    // An unknown zone name; nothing to compute from.
    return null;
  }
}

/**
 * The next time it is `hour:minute` in `zone`. A reset is always ahead of us,
 * so a time that has already passed today is tomorrow's.
 */
function isoFromClock(
  hour: number,
  minute: number,
  meridiem: string | undefined,
  zone: string,
  now: Date,
): string | null {
  let hours = hour;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    const pm = meridiem.toLowerCase() === 'pm';
    hours = pm ? (hours === 12 ? 12 : hours + 12) : hours === 12 ? 0 : hours;
  } else if (hours > 23) {
    return null;
  }
  if (minute > 59) return null;

  const offset = zoneOffsetMinutes(zone.trim(), now);
  if (offset === null) return null;

  // The date, in that zone, that "today" refers to.
  const local = new Date(now.getTime() + offset * 60_000);
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hours, minute);
  const asInstant = target - offset * 60_000;
  const ms = asInstant > now.getTime() ? asInstant : asInstant + 86_400_000;
  return new Date(ms).toISOString();
}

/**
 * The reset pattern matches the *shape* of a timestamp, not a real date, so
 * `2026-13-45T00:00` gets through it. Parsing that and calling `toISOString()`
 * throws — which would turn a quota stop into a plain failure and cost the run
 * its automatic resume. A date we cannot read is simply no date.
 */
function isoOrNull(raw: string): string | null {
  const parsed = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function epochToIso(raw: string): string | null {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return null;
  // Accept both seconds and milliseconds.
  const ms = raw.length > 10 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** When the allowance comes back, from whichever form the message used. */
function resetFrom(haystack: string, now: Date): string | null {
  const iso = RESET_ISO.exec(haystack);
  if (iso?.[1]) return isoOrNull(iso[1]);

  const clock = RESET_CLOCK.exec(haystack);
  if (clock?.[1] && clock[4]) {
    return isoFromClock(Number(clock[1]), Number(clock[2] ?? 0), clock[3], clock[4], now);
  }
  return null;
}

/**
 * Inspect CLI output for a "you are out of quota" signal. Runs that match are
 * parked as `rate_limited` and picked back up by the auto-resume sweep instead
 * of being reported as plain failures.
 */
export function detectRateLimit(
  ...texts: Array<string | null | undefined>
): RateLimitInfo {
  return detectRateLimitAt(new Date(), ...texts);
}

/** As `detectRateLimit`, with the clock injected so a wall-clock reset is testable. */
export function detectRateLimitAt(
  now: Date,
  ...texts: Array<string | null | undefined>
): RateLimitInfo {
  const haystack = texts.filter((t): t is string => typeof t === 'string' && t.length > 0).join('\n');
  if (!haystack) return NOT_LIMITED;

  const withEpoch = USAGE_LIMIT_WITH_EPOCH.exec(haystack);
  if (withEpoch?.[1]) {
    return {
      limited: true,
      resetAt: epochToIso(withEpoch[1]),
      scope: /weekly/i.test(haystack) ? 'weekly' : 'session',
      evidence: withEpoch[0],
    };
  }

  for (const { re, scope } of LIMIT_PATTERNS) {
    const match = re.exec(haystack);
    if (!match) continue;
    return {
      limited: true,
      resetAt: resetFrom(haystack, now),
      scope,
      evidence: match[0],
    };
  }

  return NOT_LIMITED;
}
