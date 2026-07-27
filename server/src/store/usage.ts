import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import type { UsageTotals, UsageWindow, WindowKind } from '../types.js';
import { getSettings } from './settings.js';

interface WindowRow {
  id: string;
  kind: string;
  started_at: string;
  ends_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  cost_usd: number;
  run_count: number;
}

function toWindow(row: WindowRow): UsageWindow {
  return {
    id: row.id,
    kind: row.kind as WindowKind,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    runCount: row.run_count,
  };
}

export function windowDurationMs(kind: WindowKind): number {
  const settings = getSettings();
  return kind === 'session'
    ? settings.sessionWindowHours * 3_600_000
    : settings.weeklyWindowDays * 86_400_000;
}

/** The window of `kind` that is currently open, or null when the quota has fully reset. */
export function getActiveWindow(kind: WindowKind, at: Date = new Date()): UsageWindow | null {
  const row = db
    .prepare<[string, string], WindowRow>(
      'SELECT * FROM usage_windows WHERE kind = ? AND ends_at > ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(kind, at.toISOString());
  return row ? toWindow(row) : null;
}

export function listWindows(kind: WindowKind, limit = 20): UsageWindow[] {
  return db
    .prepare<[string, number], WindowRow>(
      'SELECT * FROM usage_windows WHERE kind = ? ORDER BY started_at DESC LIMIT ?',
    )
    .all(kind, limit)
    .map(toWindow);
}

/**
 * Make sure a window of each kind covers `at`, opening a fresh one when the
 * previous has expired. Mirrors how Claude starts a session window on the first
 * message after a reset.
 */
export function openWindows(at: Date = new Date()): Record<WindowKind, UsageWindow> {
  const open = (kind: WindowKind): UsageWindow => {
    const existing = getActiveWindow(kind, at);
    if (existing) {
      db.prepare('UPDATE usage_windows SET run_count = run_count + 1 WHERE id = ?').run(existing.id);
      return { ...existing, runCount: existing.runCount + 1 };
    }
    const id = randomUUID();
    const endsAt = new Date(at.getTime() + windowDurationMs(kind)).toISOString();
    db.prepare(
      'INSERT INTO usage_windows (id, kind, started_at, ends_at, run_count) VALUES (?, ?, ?, ?, 1)',
    ).run(id, kind, at.toISOString(), endsAt);
    return {
      id,
      kind,
      startedAt: at.toISOString(),
      endsAt,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      runCount: 1,
    };
  };
  return { session: open('session'), weekly: open('weekly') };
}

export function addUsage(windowId: string, totals: UsageTotals): void {
  db.prepare(
    `UPDATE usage_windows SET
       input_tokens = input_tokens + ?,
       output_tokens = output_tokens + ?,
       cache_creation_tokens = cache_creation_tokens + ?,
       cache_read_tokens = cache_read_tokens + ?,
       total_tokens = total_tokens + ?,
       cost_usd = cost_usd + ?
     WHERE id = ?`,
  ).run(
    totals.inputTokens,
    totals.outputTokens,
    totals.cacheCreationTokens,
    totals.cacheReadTokens,
    totals.totalTokens,
    totals.costUsd,
    windowId,
  );
}

export interface QuotaSlice {
  kind: WindowKind;
  window: UsageWindow | null;
  /** Tokens spent in the open window. */
  used: number;
  /** Configured allowance; 0 means "not configured". */
  budget: number;
  /** Tokens left before the budget (minus reserve) is hit; null when unconfigured. */
  remaining: number | null;
  /** Share of the budget still free, 0-100; null when unconfigured. */
  remainingPct: number | null;
  /** When the current window closes and the quota resets. */
  resetsAt: string | null;
  /** True when no window is open, i.e. the full allowance is available. */
  fresh: boolean;
  exhausted: boolean;
}

export interface QuotaState {
  session: QuotaSlice;
  weekly: QuotaSlice;
  /** False when the guard is on and either slice is exhausted. */
  canRun: boolean;
  reason: string | null;
}

function slice(kind: WindowKind, budget: number, reservePct: number, at: Date): QuotaSlice {
  const window = getActiveWindow(kind, at);
  const used = window?.totalTokens ?? 0;
  const effectiveBudget = budget > 0 ? Math.max(0, Math.floor(budget * (1 - reservePct / 100))) : 0;
  const remaining = effectiveBudget > 0 ? Math.max(0, effectiveBudget - used) : null;
  const remainingPct =
    effectiveBudget > 0 ? Math.max(0, Math.min(100, (100 * (effectiveBudget - used)) / effectiveBudget)) : null;
  return {
    kind,
    window,
    used,
    budget: effectiveBudget,
    remaining,
    remainingPct,
    resetsAt: window?.endsAt ?? null,
    fresh: window === null,
    exhausted: remaining !== null && remaining <= 0,
  };
}

export function getQuotaState(at: Date = new Date()): QuotaState {
  const settings = getSettings();
  const session = slice('session', settings.sessionTokenBudget, settings.quotaReservePct, at);
  const weekly = slice('weekly', settings.weeklyTokenBudget, settings.quotaReservePct, at);

  let reason: string | null = null;
  if (settings.quotaGuardEnabled) {
    if (session.exhausted) reason = 'Session (5h) token budget exhausted';
    else if (weekly.exhausted) reason = 'Weekly token budget exhausted';
  }
  return { session, weekly, canRun: reason === null, reason };
}
