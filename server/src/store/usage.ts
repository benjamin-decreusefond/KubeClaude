import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db } from '../db.js';
import type { BudgetBasis, UsageTotals, UsageWindow, WindowKind } from '../types.js';
import { getSettings } from './settings.js';

interface WindowRow {
  id: string;
  kind: string;
  started_at: string;
  ends_at: string;
  ends_at_observed: number;
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
    endsAtObserved: boolFromDb(row.ends_at_observed),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    runCount: row.run_count,
  };
}

export interface QuotaResetObservation {
  kind: WindowKind;
  /** When Claude says the allowance returns. */
  resetAt: string;
  observedAt: string;
  source: string;
  runId: string | null;
  evidence: string | null;
}

interface ResetRow {
  kind: string;
  reset_at: string;
  observed_at: string;
  source: string;
  run_id: string | null;
  evidence: string | null;
}

function toObservation(row: ResetRow): QuotaResetObservation {
  return {
    kind: row.kind as WindowKind,
    resetAt: row.reset_at,
    observedAt: row.observed_at,
    source: row.source,
    runId: row.run_id,
    evidence: row.evidence,
  };
}

/**
 * Write down when Claude said the allowance comes back, and move the open
 * window's end to match.
 *
 * The window is corrected in the same transaction as the observation: the whole
 * point is that the gauge, the guard and the reset trigger stop disagreeing
 * with the thing that actually decides whether a run may start.
 *
 * A reset already in the past is dropped rather than stored. It tells us nothing
 * about the window we are in now, and moving `ends_at` backwards would close a
 * live window and hand out an allowance that has not returned.
 */
export function recordQuotaReset(
  input: Omit<QuotaResetObservation, 'observedAt' | 'source'> & { source?: string },
  at: Date = new Date(),
): QuotaResetObservation | null {
  const reset = new Date(input.resetAt);
  if (Number.isNaN(reset.getTime()) || reset.getTime() <= at.getTime()) return null;

  const observation: QuotaResetObservation = {
    kind: input.kind,
    resetAt: reset.toISOString(),
    observedAt: at.toISOString(),
    source: input.source ?? 'cli',
    runId: input.runId,
    evidence: input.evidence,
  };

  db.transaction(() => {
    db.prepare(
      `INSERT INTO quota_resets (id, kind, reset_at, observed_at, source, run_id, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, reset_at) DO NOTHING`,
    ).run(
      randomUUID(),
      observation.kind,
      observation.resetAt,
      observation.observedAt,
      observation.source,
      observation.runId,
      observation.evidence,
    );

    // Only the window that is open right now: a past window's end is history,
    // and a future one does not exist yet.
    const active = getActiveWindow(observation.kind, at);
    if (active && active.endsAt !== observation.resetAt) {
      db.prepare('UPDATE usage_windows SET ends_at = ?, ends_at_observed = 1 WHERE id = ?').run(
        observation.resetAt,
        active.id,
      );
    }
  })();

  return observation;
}

/**
 * The reset Claude has told us about that has not happened yet, if any.
 *
 * The *earliest* still-future observation wins. Two live observations mean the
 * allowance returns twice; the one that matters for "when can I run again" is
 * the nearer one.
 */
export function getKnownResetAt(kind: WindowKind, at: Date = new Date()): string | null {
  const row = db
    .prepare<[string, string], ResetRow>(
      'SELECT * FROM quota_resets WHERE kind = ? AND reset_at > ? ORDER BY reset_at LIMIT 1',
    )
    .get(kind, at.toISOString());
  return row?.reset_at ?? null;
}

/** Recent observations, newest first — for showing where a reset time came from. */
export function listQuotaResets(kind: WindowKind, limit = 10): QuotaResetObservation[] {
  return db
    .prepare<[string, number], ResetRow>(
      'SELECT * FROM quota_resets WHERE kind = ? ORDER BY reset_at DESC LIMIT ?',
    )
    .all(kind, limit)
    .map(toObservation);
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
  return { session: openWindow('session', at, true), weekly: openWindow('weekly', at, true) };
}

/**
 * The windows covering `at`, without counting a run against them.
 *
 * Spend is booked when a run reports it, which can be in a later window than
 * the one it started in — a long run outlives a 5-hour window. Booking it back
 * to the window it started in would leave the tokens in a window nothing
 * consults again, and the guard would see the live window as emptier than it
 * is. Erring towards the live window protects the budget rather than the
 * bookkeeping.
 */
export function currentWindows(at: Date = new Date()): Record<WindowKind, UsageWindow> {
  return { session: openWindow('session', at, false), weekly: openWindow('weekly', at, false) };
}

function openWindow(kind: WindowKind, at: Date, countRun: boolean): UsageWindow {
  const existing = getActiveWindow(kind, at);
  if (existing) {
    if (!countRun) return existing;
    db.prepare('UPDATE usage_windows SET run_count = run_count + 1 WHERE id = ?').run(existing.id);
    return { ...existing, runCount: existing.runCount + 1 };
  }

  const id = randomUUID();
  const runCount = countRun ? 1 : 0;
  // Claude's word on when this allowance returns, if it has given one, rather
  // than started_at plus the configured duration. The arithmetic assumes the
  // window opened when KubeClaude first booked a run, which is only true if
  // nothing else has talked to Claude this session.
  const known = getKnownResetAt(kind, at);
  const observed = known !== null;
  const endsAt = known ?? new Date(at.getTime() + windowDurationMs(kind)).toISOString();
  db.prepare(
    'INSERT INTO usage_windows (id, kind, started_at, ends_at, ends_at_observed, run_count) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, kind, at.toISOString(), endsAt, boolToDb(observed), runCount);
  return {
    id,
    kind,
    startedAt: at.toISOString(),
    endsAt,
    endsAtObserved: observed,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    runCount,
  };
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

/**
 * Multipliers used by the `weighted` basis, taken from Anthropic's published
 * cache pricing: a cache read costs a tenth of a fresh input token and a cache
 * write costs 1.25x (5-minute TTL). Counting them at face value is what makes a
 * raw sum useless as a budget — a long agentic run re-reads its whole cached
 * prefix every turn, so cache reads routinely dwarf everything else.
 */
export const CACHE_READ_WEIGHT = 0.1;
export const CACHE_WRITE_WEIGHT = 1.25;

/** The four raw counters, shared by usage windows, run totals and live turns. */
export interface TokenParts {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/**
 * Tokens counted against a budget, per the configured basis. Lives here rather
 * than beside the gauge because the per-run ceiling has to weigh a run's spend
 * the same way the window gauge weighs it — otherwise a cap of N would mean two
 * different things depending on where you read it.
 */
export function weighTokens(parts: TokenParts, basis: BudgetBasis): number {
  switch (basis) {
    case 'total':
      return (
        parts.inputTokens + parts.outputTokens + parts.cacheCreationTokens + parts.cacheReadTokens
      );
    case 'input_output':
      return parts.inputTokens + parts.outputTokens;
    case 'weighted':
    default:
      return Math.round(
        parts.inputTokens +
          parts.outputTokens +
          parts.cacheCreationTokens * CACHE_WRITE_WEIGHT +
          parts.cacheReadTokens * CACHE_READ_WEIGHT,
      );
  }
}

export function budgetedTokens(window: UsageWindow, basis: BudgetBasis): number {
  // `total` reads the stored column rather than re-adding the parts, so a window
  // whose totals were written directly still reports what it was given.
  return basis === 'total' ? window.totalTokens : weighTokens(window, basis);
}

export interface QuotaSlice {
  kind: WindowKind;
  window: UsageWindow | null;
  /** Tokens counted against the budget in the open window, per `basis`. */
  used: number;
  /** How `used` was derived from the window's raw counters. */
  basis: BudgetBasis;
  /** Configured allowance; 0 means "not configured". */
  budget: number;
  /** Tokens left before the budget (minus reserve) is hit; null when unconfigured. */
  remaining: number | null;
  /** Share of the budget still free, 0-100; null when unconfigured. */
  remainingPct: number | null;
  /** When the current window closes and the quota resets. */
  resetsAt: string | null;
  /**
   * True when `resetsAt` is Claude's own answer rather than our arithmetic.
   * An estimate is right to within however long ago the session really began;
   * an observation is right to the minute.
   */
  resetsAtObserved: boolean;
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

function slice(
  kind: WindowKind,
  budget: number,
  reservePct: number,
  basis: BudgetBasis,
  at: Date,
): QuotaSlice {
  const window = getActiveWindow(kind, at);
  const used = window ? budgetedTokens(window, basis) : 0;
  // With no window open the allowance is already back, so a pending observation
  // is the next reset rather than this one — hence only the open window's end.
  const known = window ? getKnownResetAt(kind, at) : null;
  const effectiveBudget = budget > 0 ? Math.max(0, Math.floor(budget * (1 - reservePct / 100))) : 0;
  const remaining = effectiveBudget > 0 ? Math.max(0, effectiveBudget - used) : null;
  const remainingPct =
    effectiveBudget > 0 ? Math.max(0, Math.min(100, (100 * (effectiveBudget - used)) / effectiveBudget)) : null;
  return {
    kind,
    window,
    used,
    basis,
    budget: effectiveBudget,
    remaining,
    remainingPct,
    resetsAt: known ?? window?.endsAt ?? null,
    resetsAtObserved: known !== null || (window?.endsAtObserved ?? false),
    fresh: window === null,
    exhausted: remaining !== null && remaining <= 0,
  };
}

export function getQuotaState(at: Date = new Date()): QuotaState {
  const settings = getSettings();
  const basis = settings.budgetBasis;
  const session = slice('session', settings.sessionTokenBudget, settings.quotaReservePct, basis, at);
  const weekly = slice('weekly', settings.weeklyTokenBudget, settings.quotaReservePct, basis, at);

  let reason: string | null = null;
  if (settings.quotaGuardEnabled) {
    if (session.exhausted) reason = 'Session (5h) token budget exhausted';
    else if (weekly.exhausted) reason = 'Weekly token budget exhausted';
  }
  return { session, weekly, canRun: reason === null, reason };
}
