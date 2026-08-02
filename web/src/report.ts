import { api } from './api';

/**
 * Send a browser fault to the error feed.
 *
 * Two things this must never do: report the same fault twice a second (a render
 * that throws in a loop would fill the feed with itself), and throw. A reporter
 * that fails loudly inside an error handler is how one bug becomes a crash.
 */

/** Distinct faults remembered for the life of the page. */
const seen = new Map<string, number>();
/** How long the same fault stays quiet after being reported. */
const QUIET_MS = 60_000;
/** Ceiling for one page load, so a runaway loop cannot flood the API either. */
const MAX_PER_PAGE = 20;

let sent = 0;

export function reportBrowserError(error: unknown, context?: string): void {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return;

  const detail = error instanceof Error ? error.stack : undefined;
  const key = `${message}::${context ?? ''}`;
  const now = Date.now();
  const last = seen.get(key);
  if (last !== undefined && now - last < QUIET_MS) return;
  if (sent >= MAX_PER_PAGE) return;

  seen.set(key, now);
  sent += 1;
  void api
    .reportError({
      message,
      detail: detail ?? undefined,
      context: context ?? window.location.pathname,
    })
    .catch(() => undefined);
}

/**
 * Catch what React does not: an error thrown outside rendering, and a promise
 * nothing awaited. Registered once, from the entry point.
 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (event) => {
    reportBrowserError(event.error ?? event.message, window.location.pathname);
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportBrowserError(event.reason, `${window.location.pathname} (unhandled rejection)`);
  });
}
