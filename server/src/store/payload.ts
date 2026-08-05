import { config } from '../config.js';

/**
 * Cut an event down to something worth storing.
 *
 * The runner already refuses a single line over 8 MB, so nothing here is
 * unbounded — but "not unbounded" is a long way from "small". A prompt that
 * reads a file, greps a repository or curls an endpoint produces tool results
 * that are megabytes of text, and every one of them is written to SQLite, read
 * back by `/api/runs/:id/events` and held in a browser tab.
 *
 * What a person reads is the beginning of that text, and the fact that there was
 * more. So the long strings are cut and marked rather than the message being
 * dropped: the shape survives — which tool, what arguments, whether it errored —
 * and the bulk does not.
 */

/** Longest string kept intact inside an oversized payload. */
const STRING_LIMIT = 4_000;
/** Second pass, for a payload made of many merely-large strings. */
const TIGHT_STRING_LIMIT = 400;
/** Longest array kept intact; the rest becomes one marker entry. */
const ARRAY_LIMIT = 200;
/**
 * Deep enough for any stream-json message, and a bound on the recursion below.
 * It never was the guard against cyclic input it once claimed to be: `bytes`
 * runs first, and `JSON.stringify` throws on a cycle long before the recursion
 * that this limits is reached. That is handled where it happens instead.
 */
const MAX_DEPTH = 12;

/**
 * How big this is once serialised, or null when it cannot be serialised at all.
 *
 * `JSON.stringify` throws on a cycle, on a BigInt, and on a `toJSON` that
 * throws. `appendEvent` runs from a stream handler and is documented as never
 * throwing — it returns null instead — so nothing on that path is allowed to,
 * and reporting the failure is the only way to keep that true here.
 */
function bytes(value: unknown): number | null {
  try {
    const json = JSON.stringify(value ?? null);
    return json === undefined ? 0 : Buffer.byteLength(json);
  } catch {
    return null;
  }
}

/** A label worth keeping in the log; anything else is not worth risking. */
function labelOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function clampString(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} more characters, not stored]`;
}

function clampValue(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return clampString(value, limit);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '… [too deeply nested to store]';

  if (Array.isArray(value)) {
    const kept = value.slice(0, ARRAY_LIMIT).map((entry) => clampValue(entry, limit, depth + 1));
    if (value.length > ARRAY_LIMIT) kept.push(`… [${value.length - ARRAY_LIMIT} more entries, not stored]`);
    return kept;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clampValue(entry, limit, depth + 1);
  }
  return out;
}

/**
 * Returns the payload as it should be stored, and how big it was before. A
 * payload under the ceiling is returned untouched, so the common case pays only
 * for one `JSON.stringify`.
 */
export function clampPayload(
  payload: unknown,
  maxBytes: number = config.maxEventBytes,
): { payload: unknown; originalBytes: number; truncated: boolean } {
  const value = payload ?? null;
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  // Only ever strings, so building the fallback cannot itself fail on whatever
  // made the message unserialisable in the first place.
  const labels = { type: labelOf(record.type), subtype: labelOf(record.subtype) };

  const originalBytes = bytes(value);
  if (originalBytes === null) {
    // Nothing here can be written down as it stands. Saying so keeps the run's
    // log honest about the gap, where dropping the line would leave the output
    // looking complete with a message quietly missing from the middle of it.
    return {
      payload: { ...labels, truncated: 'This message could not be serialised, so it was not stored.' },
      originalBytes: 0,
      truncated: true,
    };
  }
  if (originalBytes <= maxBytes) return { payload: value, originalBytes, truncated: false };

  for (const limit of [STRING_LIMIT, TIGHT_STRING_LIMIT]) {
    const clamped = clampValue(value, limit);
    const size = bytes(clamped);
    if (size !== null && size <= maxBytes) return { payload: clamped, originalBytes, truncated: true };
  }

  // Nothing about the message is small — thousands of short fields, say. Keep
  // the two labels the log renders from and say plainly what happened.
  return {
    payload: {
      ...labels,
      truncated: `This message was ${originalBytes} bytes and was not stored; the limit is ${maxBytes} (MAX_EVENT_BYTES).`,
    },
    originalBytes,
    truncated: true,
  };
}
