import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db, jsonFromDb } from '../db.js';
import type { Goal, GoalIteration, GoalStatus, Objective } from '../types.js';

interface GoalRow {
  id: string;
  prompt_id: string;
  name: string;
  description: string;
  objectives: string;
  status: string;
  cadence_minutes: number;
  max_iterations: number;
  iteration: number;
  stop_when_achieved: number;
  review_model: string | null;
  last_run_id: string | null;
  last_iteration_at: string | null;
  created_at: string;
  updated_at: string;
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    promptId: row.prompt_id,
    name: row.name,
    description: row.description,
    objectives: jsonFromDb<Objective[]>(row.objectives, []),
    status: row.status as GoalStatus,
    cadenceMinutes: row.cadence_minutes,
    maxIterations: row.max_iterations,
    iteration: row.iteration,
    stopWhenAchieved: boolFromDb(row.stop_when_achieved),
    reviewModel: row.review_model,
    lastRunId: row.last_run_id,
    lastIterationAt: row.last_iteration_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Objective ids are positional and never reused, so the log keeps making sense. */
export function makeObjectives(texts: string[], existing: Objective[] = []): Objective[] {
  const taken = new Set(existing.map((objective) => objective.id));
  let next = existing.length + 1;
  const freshId = (): string => {
    while (taken.has(`o${next}`)) next += 1;
    taken.add(`o${next}`);
    return `o${next}`;
  };
  return texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ id: freshId(), text, done: false, doneAt: null, note: null }));
}

export interface GoalInput {
  promptId: string;
  name: string;
  description: string;
  objectives: Objective[];
  status: GoalStatus;
  cadenceMinutes: number;
  maxIterations: number;
  stopWhenAchieved: boolean;
  reviewModel: string | null;
}

export function listGoals(): Goal[] {
  return db
    .prepare<[], GoalRow>('SELECT * FROM goals ORDER BY updated_at DESC')
    .all()
    .map(toGoal);
}

/** Goals the loop should look at; ended and paused ones are left alone. */
export function listActiveGoals(): Goal[] {
  return db
    .prepare<[], GoalRow>("SELECT * FROM goals WHERE status = 'active' ORDER BY updated_at")
    .all()
    .map(toGoal);
}

export function getGoal(id: string): Goal | null {
  const row = db.prepare<[string], GoalRow>('SELECT * FROM goals WHERE id = ?').get(id);
  return row ? toGoal(row) : null;
}

export function getGoalByPromptId(promptId: string): Goal | null {
  const row = db.prepare<[string], GoalRow>('SELECT * FROM goals WHERE prompt_id = ?').get(promptId);
  return row ? toGoal(row) : null;
}

export function createGoal(input: GoalInput): Goal {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO goals (
       id, prompt_id, name, description, objectives, status, cadence_minutes, max_iterations,
       iteration, stop_when_achieved, review_model, last_run_id, last_iteration_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, ?, ?)`,
  ).run(
    id,
    input.promptId,
    input.name,
    input.description,
    JSON.stringify(input.objectives),
    input.status,
    input.cadenceMinutes,
    input.maxIterations,
    boolToDb(input.stopWhenAchieved),
    input.reviewModel,
    now,
    now,
  );
  return getGoal(id)!;
}

const COLUMN_BY_FIELD: Record<string, string> = {
  name: 'name',
  description: 'description',
  objectives: 'objectives',
  status: 'status',
  cadenceMinutes: 'cadence_minutes',
  maxIterations: 'max_iterations',
  iteration: 'iteration',
  stopWhenAchieved: 'stop_when_achieved',
  reviewModel: 'review_model',
  lastRunId: 'last_run_id',
  lastIterationAt: 'last_iteration_at',
};

export function updateGoal(id: string, patch: Partial<Goal>): Goal | null {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = COLUMN_BY_FIELD[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    if (field === 'objectives') values.push(JSON.stringify(value));
    else if (field === 'stopWhenAchieved') values.push(boolToDb(Boolean(value)));
    else values.push(value);
  }

  if (assignments.length === 0) return getGoal(id);

  assignments.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE goals SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getGoal(id);
}

/**
 * Tick objectives off the goal **as it is now**, rather than as the caller last
 * saw it.
 *
 * An iteration can take minutes, and the person watching it is invited to add
 * objectives while it runs. Writing back the array the review started from
 * would erase whatever they added in the meantime — silently, since the write
 * looks like an ordinary update. Reading and writing inside one transaction is
 * what makes the two safe to do at once.
 */
export function tickObjectives(id: string, achieved: string[], note: string): Goal | null {
  if (achieved.length === 0) return getGoal(id);

  return db.transaction(() => {
    const current = getGoal(id);
    if (!current) return null;

    const now = new Date().toISOString();
    const trimmed = note.trim();
    const objectives = current.objectives.map((objective) =>
      achieved.includes(objective.id) && !objective.done
        ? {
            ...objective,
            done: true,
            doneAt: now,
            note: trimmed ? trimmed.slice(0, 400) : 'Closed by an iteration',
          }
        : objective,
    );

    db.prepare('UPDATE goals SET objectives = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(objectives),
      now,
      id,
    );
    return getGoal(id);
  })();
}

/**
 * Count an iteration as started. The increment happens in SQL rather than from
 * a number the caller read earlier, so it cannot lose count.
 */
export function recordIterationStart(id: string, runId: string): Goal | null {
  db.prepare(
    'UPDATE goals SET iteration = iteration + 1, last_run_id = ?, last_iteration_at = ?, updated_at = ? WHERE id = ?',
  ).run(runId, new Date().toISOString(), new Date().toISOString(), id);
  return getGoal(id);
}

export function deleteGoal(id: string): boolean {
  return db.prepare('DELETE FROM goals WHERE id = ?').run(id).changes > 0;
}

// --------------------------------------------------------------------------
// Iterations
// --------------------------------------------------------------------------

interface IterationRow {
  id: string;
  goal_id: string;
  seq: number;
  run_id: string | null;
  created_at: string;
  summary: string;
  next_step: string | null;
  achieved: string;
  source: string;
  run_status: string | null;
}

function toIteration(row: IterationRow): GoalIteration {
  return {
    id: row.id,
    goalId: row.goal_id,
    seq: row.seq,
    runId: row.run_id,
    createdAt: row.created_at,
    summary: row.summary,
    nextStep: row.next_step,
    achieved: jsonFromDb<string[]>(row.achieved, []),
    source: row.source as GoalIteration['source'],
    runStatus: row.run_status,
  };
}

export type IterationInput = Omit<GoalIteration, 'id' | 'seq' | 'createdAt'>;

/**
 * Record what an iteration achieved. The unique index on `run_id` means a run
 * that somehow gets swept twice is only ever logged once — the second insert
 * is dropped rather than duplicating the progress.
 */
export function addIteration(input: IterationInput): GoalIteration | null {
  const row = db
    .prepare<[string], { next: number }>(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM goal_iterations WHERE goal_id = ?',
    )
    .get(input.goalId);
  const seq = row?.next ?? 1;
  const id = randomUUID();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO goal_iterations (
         id, goal_id, seq, run_id, created_at, summary, next_step, achieved, source, run_status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.goalId,
      seq,
      input.runId,
      new Date().toISOString(),
      input.summary,
      input.nextStep,
      JSON.stringify(input.achieved),
      input.source,
      input.runStatus,
    );
  return result.changes > 0 ? getIteration(id) : null;
}

function getIteration(id: string): GoalIteration | null {
  const row = db.prepare<[string], IterationRow>('SELECT * FROM goal_iterations WHERE id = ?').get(id);
  return row ? toIteration(row) : null;
}

/** The progress log, oldest first. */
export function listIterations(goalId: string, limit = 100): GoalIteration[] {
  return db
    .prepare<[string, number], IterationRow>(
      'SELECT * FROM goal_iterations WHERE goal_id = ? ORDER BY seq DESC LIMIT ?',
    )
    .all(goalId, limit)
    .map(toIteration)
    .reverse();
}

export function hasIterationForRun(runId: string): boolean {
  const row = db
    .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM goal_iterations WHERE run_id = ?')
    .get(runId);
  return (row?.count ?? 0) > 0;
}
