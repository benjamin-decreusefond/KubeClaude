import { db } from '../db.js';
import type { ModelUsage, Run } from '../types.js';
import { listRuns } from './runs.js';
import { getQuotaState, listWindows } from './usage.js';

export interface PeriodTotals {
  runs: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  costUsd: number;
  durationMs: number;
  apiDurationMs: number;
  turns: number;
}

interface TotalsRow {
  runs: number | null;
  succeeded: number | null;
  failed: number | null;
  rate_limited: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  api_duration_ms: number | null;
  turns: number | null;
}

const TOTALS_SELECT = `
  SELECT
    COUNT(*) AS runs,
    SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
    SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN status = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    SUM(cache_creation_tokens) AS cache_creation_tokens,
    SUM(cache_read_tokens) AS cache_read_tokens,
    SUM(total_tokens) AS total_tokens,
    SUM(cost_usd) AS cost_usd,
    SUM(duration_ms) AS duration_ms,
    SUM(duration_api_ms) AS api_duration_ms,
    SUM(num_turns) AS turns
  FROM runs
`;

function toTotals(row: TotalsRow | undefined): PeriodTotals {
  return {
    runs: row?.runs ?? 0,
    succeeded: row?.succeeded ?? 0,
    failed: row?.failed ?? 0,
    rateLimited: row?.rate_limited ?? 0,
    inputTokens: row?.input_tokens ?? 0,
    outputTokens: row?.output_tokens ?? 0,
    cacheCreationTokens: row?.cache_creation_tokens ?? 0,
    cacheReadTokens: row?.cache_read_tokens ?? 0,
    totalTokens: row?.total_tokens ?? 0,
    costUsd: row?.cost_usd ?? 0,
    durationMs: row?.duration_ms ?? 0,
    apiDurationMs: row?.api_duration_ms ?? 0,
    turns: row?.turns ?? 0,
  };
}

export function totalsSince(since: Date | null): PeriodTotals {
  const row = since
    ? db.prepare<[string], TotalsRow>(`${TOTALS_SELECT} WHERE queued_at >= ?`).get(since.toISOString())
    : db.prepare<[], TotalsRow>(TOTALS_SELECT).get();
  return toTotals(row);
}

export interface DailyPoint {
  date: string;
  runs: number;
  totalTokens: number;
  costUsd: number;
}

export function dailySeries(days: number): DailyPoint[] {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = db
    .prepare<[string], { date: string; runs: number; total_tokens: number | null; cost_usd: number | null }>(
      `SELECT substr(queued_at, 1, 10) AS date,
              COUNT(*) AS runs,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd
       FROM runs WHERE queued_at >= ?
       GROUP BY date ORDER BY date`,
    )
    .all(since.toISOString());

  const byDate = new Map(rows.map((row) => [row.date, row]));
  const series: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const row = byDate.get(date);
    series.push({
      date,
      runs: row?.runs ?? 0,
      totalTokens: row?.total_tokens ?? 0,
      costUsd: row?.cost_usd ?? 0,
    });
  }
  return series;
}

export interface ModelBreakdown extends ModelUsage {
  model: string;
  totalTokens: number;
  runs: number;
}

/**
 * Aggregate `modelUsage` across runs. Rows without a breakdown fall back to the
 * run's own totals attributed to its reported model.
 */
export function modelBreakdown(since: Date): ModelBreakdown[] {
  const rows = db
    .prepare<
      [string],
      {
        model: string | null;
        model_usage: string | null;
        input_tokens: number;
        output_tokens: number;
        cache_creation_tokens: number;
        cache_read_tokens: number;
        cost_usd: number | null;
      }
    >(
      `SELECT model, model_usage, input_tokens, output_tokens, cache_creation_tokens,
              cache_read_tokens, cost_usd
       FROM runs WHERE queued_at >= ? AND total_tokens > 0`,
    )
    .all(since.toISOString());

  const totals = new Map<string, ModelBreakdown>();
  const bump = (model: string, usage: ModelUsage): void => {
    const current = totals.get(model) ?? {
      model,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      totalTokens: 0,
      runs: 0,
    };
    current.inputTokens += usage.inputTokens;
    current.outputTokens += usage.outputTokens;
    current.cacheCreationTokens += usage.cacheCreationTokens;
    current.cacheReadTokens += usage.cacheReadTokens;
    current.costUsd += usage.costUsd;
    current.totalTokens +=
      usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens;
    current.runs += 1;
    totals.set(model, current);
  };

  for (const row of rows) {
    let parsed: Record<string, ModelUsage> | null = null;
    if (row.model_usage) {
      try {
        parsed = JSON.parse(row.model_usage) as Record<string, ModelUsage>;
      } catch {
        parsed = null;
      }
    }
    if (parsed) {
      for (const [model, usage] of Object.entries(parsed)) bump(model, usage);
    } else {
      bump(row.model ?? 'unknown', {
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheCreationTokens: row.cache_creation_tokens,
        cacheReadTokens: row.cache_read_tokens,
        costUsd: row.cost_usd ?? 0,
      });
    }
  }

  return [...totals.values()].sort((a, b) => b.totalTokens - a.totalTokens);
}

export interface PromptBreakdown {
  promptId: string;
  promptName: string;
  runs: number;
  totalTokens: number;
  costUsd: number;
  failed: number;
}

export function promptBreakdown(since: Date, limit = 8): PromptBreakdown[] {
  return db
    .prepare<
      [string, number],
      {
        prompt_id: string;
        prompt_name: string;
        runs: number;
        total_tokens: number | null;
        cost_usd: number | null;
        failed: number | null;
      }
    >(
      `SELECT prompt_id, prompt_name,
              COUNT(*) AS runs,
              SUM(total_tokens) AS total_tokens,
              SUM(cost_usd) AS cost_usd,
              SUM(CASE WHEN status IN ('failed', 'timeout') THEN 1 ELSE 0 END) AS failed
       FROM runs WHERE queued_at >= ?
       GROUP BY prompt_id, prompt_name
       ORDER BY total_tokens DESC NULLS LAST
       LIMIT ?`,
    )
    .all(since.toISOString(), limit)
    .map((row) => ({
      promptId: row.prompt_id,
      promptName: row.prompt_name,
      runs: row.runs,
      totalTokens: row.total_tokens ?? 0,
      costUsd: row.cost_usd ?? 0,
      failed: row.failed ?? 0,
    }));
}

export interface UpcomingRun {
  triggerId: string;
  promptId: string;
  promptName: string;
  type: string;
  nextFireAt: string;
  cronExpression: string | null;
  timezone: string;
}

export function upcomingRuns(limit = 8): UpcomingRun[] {
  return db
    .prepare<
      [number],
      {
        id: string;
        prompt_id: string;
        prompt_name: string;
        type: string;
        next_fire_at: string;
        cron_expression: string | null;
        timezone: string;
      }
    >(
      `SELECT t.id, t.prompt_id, p.name AS prompt_name, t.type, t.next_fire_at,
              t.cron_expression, t.timezone
       FROM triggers t JOIN prompts p ON p.id = t.prompt_id
       WHERE t.enabled = 1 AND p.enabled = 1 AND t.next_fire_at IS NOT NULL
       ORDER BY t.next_fire_at
       LIMIT ?`,
    )
    .all(limit)
    .map((row) => ({
      triggerId: row.id,
      promptId: row.prompt_id,
      promptName: row.prompt_name,
      type: row.type,
      nextFireAt: row.next_fire_at,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
    }));
}

export interface Dashboard {
  quota: ReturnType<typeof getQuotaState>;
  totals: {
    session: PeriodTotals;
    week: PeriodTotals;
    month: PeriodTotals;
    allTime: PeriodTotals;
  };
  daily: DailyPoint[];
  models: ModelBreakdown[];
  prompts: PromptBreakdown[];
  sessionWindows: ReturnType<typeof listWindows>;
  weeklyWindows: ReturnType<typeof listWindows>;
  upcoming: UpcomingRun[];
  recentRuns: Run[];
  awaitingResume: Run[];
}

export function getDashboard(): Dashboard {
  const quota = getQuotaState();
  const now = Date.now();
  const sessionStart = quota.session.window ? new Date(quota.session.window.startedAt) : new Date(now);
  const weekStart = quota.weekly.window
    ? new Date(quota.weekly.window.startedAt)
    : new Date(now - 7 * 86_400_000);

  return {
    quota,
    totals: {
      session: totalsSince(sessionStart),
      week: totalsSince(weekStart),
      month: totalsSince(new Date(now - 30 * 86_400_000)),
      allTime: totalsSince(null),
    },
    daily: dailySeries(14),
    models: modelBreakdown(new Date(now - 30 * 86_400_000)),
    prompts: promptBreakdown(new Date(now - 7 * 86_400_000)),
    sessionWindows: listWindows('session', 12),
    weeklyWindows: listWindows('weekly', 8),
    upcoming: upcomingRuns(8),
    recentRuns: listRuns({ limit: 10 }),
    awaitingResume: listRuns({ status: 'rate_limited', limit: 10 }),
  };
}
