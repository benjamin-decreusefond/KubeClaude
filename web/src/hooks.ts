import { useCallback, useEffect, useRef, useState } from 'react';
import { streamUrl } from './api';

/** Fetch on mount and on an interval, with a manual refresh escape hatch. */
export function usePolled<T>(
  loader: () => Promise<T>,
  intervalMs = 10_000,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; refresh: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const result = await loaderRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    if (intervalMs <= 0) return () => {
      cancelled = true;
    };

    const timer = setInterval(() => void load(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, refresh };
}

export type StreamHandler = (event: string, payload: unknown) => void;

/**
 * Server-sent events from the API. EventSource reconnects on its own, so this
 * only has to wire handlers and tear them down.
 */
export function useStream(handler: StreamHandler, runId?: string): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const source = new EventSource(streamUrl(runId));
    const names = ['run:created', 'run:updated', 'run:event', 'quota:changed'];

    const listeners = names.map((name) => {
      const listener = (event: MessageEvent<string>) => {
        try {
          handlerRef.current(name, JSON.parse(event.data));
        } catch {
          /* a malformed frame is not worth breaking the page over */
        }
      };
      source.addEventListener(name, listener as EventListener);
      return { name, listener };
    });

    return () => {
      for (const { name, listener } of listeners) {
        source.removeEventListener(name, listener as EventListener);
      }
      source.close();
    };
  }, [runId]);
}

export function useTheme(): [string, (theme: string) => void] {
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('kubeclaude.theme') ?? 'system');

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('kubeclaude.theme', theme);
  }, [theme]);

  return [theme, setTheme];
}

/** Re-render on a timer so relative timestamps keep counting down. */
export function useTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
