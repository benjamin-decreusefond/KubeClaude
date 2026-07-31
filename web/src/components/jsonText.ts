/**
 * Render a value that came off the Claude CLI's JSON stream as text.
 *
 * Everything in those messages is `unknown` — the CLI is free to put an object
 * where a previous version put a string — and `String(someObject)` renders as
 * `[object Object]`, which tells the reader nothing about a run they are trying
 * to understand. Showing the JSON is strictly more useful and never worse.
 */
export function asText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value) ?? fallback;
  } catch {
    // Circular, or something else JSON cannot express.
    return fallback;
  }
}
