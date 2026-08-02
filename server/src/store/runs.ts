import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db, jsonFromDb } from '../db.js';
import { config } from '../config.js';
import type { ModelUsage, Run, RunEvent, RunStatus } from '../types.js';

interface RunRow {
  id: string;
  prompt_id: string;
  prompt_name: string;
  trigger_id: string | null;
  trigger_type: string;
  status: string;
  prompt_text: string;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  session_id: string | null;
  exit_code: number | null;
  error: string | null;
  num_turns: number | null;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  total_tokens: number;
  result_text: string | null;
  model: string | null;
  model_usage: string | null;
  duration_api_ms: number | null;
  service_tier: string | null;
  resume_of_run_id: string | null;
  root_run_id: string;
  follow_up_text: string | null;
  resume_attempt: number;
  rate_limit_reset_at: string | null;
  auto_resume_pending: number;
  completed: number | null;
  completion_reason: string | null;
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    promptId: row.prompt_id,
    promptName: row.prompt_name,
    triggerId: row.trigger_id,
    triggerType: row.trigger_type,
    status: row.status as RunStatus,
    promptText: row.prompt_text,
    queuedAt: row.queued_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    sessionId: row.session_id,
    exitCode: row.exit_code,
    error: row.error,
    numTurns: row.num_turns,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheCreationTokens: row.cache_creation_tokens,
    cacheReadTokens: row.cache_read_tokens,
    totalTokens: row.total_tokens,
    resultText: row.result_text,
    model: row.model,
    modelUsage: row.model_usage ? jsonFromDb<Record<string, ModelUsage> | null>(row.model_usage, null) : null,
    durationApiMs: row.duration_api_ms,
    serviceTier: row.service_tier,
    resumeOfRunId: row.resume_of_run_id,
    rootRunId: row.root_run_id,
    followUpText: row.follow_up_text,
    resumeAttempt: row.resume_attempt,
    rateLimitResetAt: row.rate_limit_reset_at,
    autoResumePending: boolFromDb(row.auto_resume_pending),
    completed: row.completed === null ? null : boolFromDb(row.completed),
    completionReason: row.completion_reason,
  };
}

export interface CreateRunInput {
  promptId: string;
  promptName: string;
  triggerId: string | null;
  triggerType: string;
  promptText: string;
  resumeOfRunId?: string | null;
  resumeAttempt?: number;
  /** Session to resume; carried on the run so the worker knows what to pass to the CLI. */
  sessionId?: string | null;
  /** Text of the human follow-up that produced this run, when there is one. */
  followUpText?: string | null;
}

export function createRun(input: CreateRunInput): Run {
  const id = randomUUID();
  // A continuation inherits its parent's thread; anything else starts one.
  const parent = input.resumeOfRunId ? getRun(input.resumeOfRunId) : null;
  const rootRunId = parent?.rootRunId ?? id;

  db.prepare(
    `INSERT INTO runs (
       id, prompt_id, prompt_name, trigger_id, trigger_type, status, prompt_text, queued_at,
       resume_of_run_id, root_run_id, follow_up_text, resume_attempt, session_id
     ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.promptId,
    input.promptName,
    input.triggerId,
    input.triggerType,
    input.promptText,
    new Date().toISOString(),
    input.resumeOfRunId ?? null,
    rootRunId,
    input.followUpText ?? null,
    input.resumeAttempt ?? 0,
    input.sessionId ?? null,
  );
  return getRun(id)!;
}

/** Every run in the same conversation, oldest first. */
export function listThread(runId: string): Run[] {
  const run = getRun(runId);
  if (!run) return [];
  return db
    .prepare<[string], RunRow>('SELECT * FROM runs WHERE root_run_id = ? ORDER BY queued_at')
    .all(run.rootRunId)
    .map(toRun);
}

export function getRun(id: string): Run | null {
  const row = db.prepare<[string], RunRow>('SELECT * FROM runs WHERE id = ?').get(id);
  return row ? toRun(row) : null;
}

export interface ListRunsOptions {
  promptId?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export function listRuns(options: ListRunsOptions = {}): Run[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.promptId) {
    where.push('prompt_id = ?');
    params.push(options.promptId);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(Math.min(options.limit ?? 50, 500), options.offset ?? 0);
  return db
    .prepare<unknown[], RunRow>(`SELECT * FROM runs ${clause} ORDER BY queued_at DESC LIMIT ? OFFSET ?`)
    .all(...(params as never[]))
    .map(toRun);
}

export function countRuns(options: Pick<ListRunsOptions, 'promptId' | 'status'> = {}): number {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options.promptId) {
    where.push('prompt_id = ?');
    params.push(options.promptId);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const row = db
    .prepare<unknown[], { count: number }>(`SELECT COUNT(*) AS count FROM runs ${clause}`)
    .get(...(params as never[]));
  return row?.count ?? 0;
}

export function listQueuedRuns(): Run[] {
  return db
    .prepare<[], RunRow>("SELECT * FROM runs WHERE status = 'queued' ORDER BY queued_at")
    .all()
    .map(toRun);
}

export function listResumableRuns(): Run[] {
  return db
    .prepare<[], RunRow>(
      `SELECT * FROM runs
       WHERE auto_resume_pending = 1 AND status = 'rate_limited'
       ORDER BY finished_at`,
    )
    .all()
    .map(toRun);
}

export function hasActiveRunForPrompt(promptId: string): boolean {
  const row = db
    .prepare<[string], { count: number }>(
      "SELECT COUNT(*) AS count FROM runs WHERE prompt_id = ? AND status IN ('queued', 'running')",
    )
    .get(promptId);
  return (row?.count ?? 0) > 0;
}

export function updateRun(id: string, patch: Partial<Run>): Run | null {
  const columns: Record<string, string> = {
    status: 'status',
    startedAt: 'started_at',
    finishedAt: 'finished_at',
    durationMs: 'duration_ms',
    sessionId: 'session_id',
    exitCode: 'exit_code',
    error: 'error',
    numTurns: 'num_turns',
    costUsd: 'cost_usd',
    inputTokens: 'input_tokens',
    outputTokens: 'output_tokens',
    cacheCreationTokens: 'cache_creation_tokens',
    cacheReadTokens: 'cache_read_tokens',
    totalTokens: 'total_tokens',
    resultText: 'result_text',
    model: 'model',
    modelUsage: 'model_usage',
    durationApiMs: 'duration_api_ms',
    serviceTier: 'service_tier',
    rateLimitResetAt: 'rate_limit_reset_at',
    autoResumePending: 'auto_resume_pending',
    completed: 'completed',
    completionReason: 'completion_reason',
  };
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    if (field === 'autoResumePending') values.push(boolToDb(Boolean(value)));
    else if (field === 'completed') values.push(value === null ? null : boolToDb(Boolean(value)));
    else if (field === 'modelUsage') values.push(value === null ? null : JSON.stringify(value));
    else values.push(value);
  }
  if (assignments.length === 0) return getRun(id);
  values.push(id);
  db.prepare(`UPDATE runs SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getRun(id);
}

/**
 * Marks a run the process could not finish because it was restarted under it.
 * Kept apart from a real failure: a pod restart is a routine event — a deploy,
 * a node drain — and counting it as the task failing would stop goals that are
 * doing nothing wrong.
 */
export const RESTART_REASON = 'restart';

/** Any run left mid-flight by a pod restart is not recoverable; close it out. */
export function failOrphanedRuns(): number {
  const now = new Date().toISOString();
  return db
    .prepare(
      `UPDATE runs SET status = 'failed', finished_at = ?, error = 'Interrupted by a KubeClaude restart',
         completion_reason = ?
       WHERE status = 'running'`,
    )
    .run(now, RESTART_REASON).changes;
}

/**
 * Record one line of a run's output.
 *
 * Returns null when the run is no longer there — deleting a prompt, a chat or a
 * goal takes its runs with it, and the Claude process behind one of them can
 * still be mid-sentence. This is called from a stream handler, so throwing here
 * would take down the whole server rather than the one run that went away.
 */
export function appendEvent(runId: string, kind: RunEvent['kind'], payload: unknown): RunEvent | null {
  const row = db
    .prepare<[string], { next: number }>('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?')
    .get(runId);
  const seq = row?.next ?? 1;
  const ts = new Date().toISOString();
  try {
    db.prepare('INSERT INTO run_events (run_id, seq, ts, kind, payload) VALUES (?, ?, ?, ?, ?)').run(
      runId,
      seq,
      ts,
      kind,
      JSON.stringify(payload ?? null),
    );
  } catch (error) {
    // A foreign key failure means the run was deleted; anything else is a real
    // problem worth surfacing.
    if (!String(error).includes('FOREIGN KEY')) throw error;
    return null;
  }
  // Trimming is batched rather than done on every line: the delete is cheap but
  // it is still a write, and a chatty run produces thousands of lines. The batch
  // is what makes the cap approximate — see TRIM_EVERY.
  if (seq % TRIM_EVERY === 0) trimEvents(runId);
  return { runId, seq, ts, kind, payload };
}

/**
 * How often the cap is enforced. A run therefore holds up to
 * `maxEventsPerRun + TRIM_EVERY - 1` lines rather than exactly the cap; keeping
 * this small is what stops that slack from being surprising.
 */
const TRIM_EVERY = 100;

function trimEvents(runId: string): void {
  db.prepare(
    `DELETE FROM run_events WHERE run_id = ? AND seq <= (
       SELECT MAX(seq) - ? FROM run_events WHERE run_id = ?
     )`,
  ).run(runId, config.maxEventsPerRun, runId);
}

export function listEvents(runId: string, afterSeq = 0): RunEvent[] {
  return db
    .prepare<[string, number], { run_id: string; seq: number; ts: string; kind: string; payload: string }>(
      'SELECT * FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq',
    )
    .all(runId, afterSeq)
    .map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      ts: row.ts,
      kind: row.kind as RunEvent['kind'],
      payload: JSON.parse(row.payload) as unknown,
    }));
}

export function pruneOldRuns(retentionDays: number): number {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const removed = db
    .prepare("DELETE FROM runs WHERE queued_at < ? AND status NOT IN ('queued', 'running', 'rate_limited')")
    .run(cutoff).changes;

  // A goal's progress log outlives the runs behind it, and a link to a run that
  // was pruned is a dead end. The entry stays — it is the record of what
  // happened — but it stops offering to show a run that is gone.
  if (removed > 0) {
    db.prepare(
      'UPDATE goal_iterations SET run_id = NULL WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)',
    ).run();
  }
  return removed;
}
