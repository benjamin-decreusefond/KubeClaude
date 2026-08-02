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

const LIMIT_PATTERNS: Array<{ re: RegExp; scope: RateLimitInfo['scope'] }> = [
  { re: /\b5[-\s]?hour limit reached/i, scope: 'session' },
  { re: /\bsession limit reached/i, scope: 'session' },
  { re: /\bweekly limit reached/i, scope: 'weekly' },
  { re: /\bweekly usage limit/i, scope: 'weekly' },
  { re: /usage limit reached/i, scope: 'unknown' },
  { re: /\brate[_\s]?limit(_error)?\b/i, scope: 'unknown' },
  { re: /\bquota exceeded\b/i, scope: 'unknown' },
  { re: /\bout of (?:usage|tokens|credits)\b/i, scope: 'unknown' },
  { re: /\b429\b.*\b(too many requests|rate)\b/i, scope: 'unknown' },
  { re: /\byou(?:'ve| have) (?:hit|reached) your (?:usage )?limit\b/i, scope: 'unknown' },
];

/** `Your limit will reset at 3pm` / `resets at 2026-07-27T18:00:00Z`. */
const RESET_ISO = /reset(?:s|ting)?\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/i;

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

/**
 * Inspect CLI output for a "you are out of quota" signal. Runs that match are
 * parked as `rate_limited` and picked back up by the auto-resume sweep instead
 * of being reported as plain failures.
 */
export function detectRateLimit(...texts: Array<string | null | undefined>): RateLimitInfo {
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
    const iso = RESET_ISO.exec(haystack);
    return {
      limited: true,
      resetAt: iso?.[1] ? isoOrNull(iso[1]) : null,
      scope,
      evidence: match[0],
    };
  }

  return NOT_LIMITED;
}
