import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db, jsonFromDb } from '../db.js';
import type { Trigger, TriggerConfig, TriggerType } from '../types.js';

interface TriggerRow {
  id: string;
  prompt_id: string;
  type: string;
  enabled: number;
  cron_expression: string | null;
  timezone: string;
  config: string;
  last_fired_at: string | null;
  next_fire_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTrigger(row: TriggerRow): Trigger {
  return {
    id: row.id,
    promptId: row.prompt_id,
    type: row.type as TriggerType,
    enabled: boolFromDb(row.enabled),
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    config: jsonFromDb<TriggerConfig>(row.config, {}),
    lastFiredAt: row.last_fired_at,
    nextFireAt: row.next_fire_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type TriggerInput = Omit<Trigger, 'id' | 'createdAt' | 'updatedAt' | 'lastFiredAt' | 'nextFireAt'>;

export function listTriggers(promptId?: string): Trigger[] {
  const rows = promptId
    ? db
        .prepare<[string], TriggerRow>('SELECT * FROM triggers WHERE prompt_id = ? ORDER BY created_at')
        .all(promptId)
    : db.prepare<[], TriggerRow>('SELECT * FROM triggers ORDER BY created_at').all();
  return rows.map(toTrigger);
}

export function listEnabledTriggers(): Trigger[] {
  return db
    .prepare<[], TriggerRow>(
      `SELECT t.* FROM triggers t
       JOIN prompts p ON p.id = t.prompt_id
       WHERE t.enabled = 1 AND p.enabled = 1
       ORDER BY t.created_at`,
    )
    .all()
    .map(toTrigger);
}

export function getTrigger(id: string): Trigger | null {
  const row = db.prepare<[string], TriggerRow>('SELECT * FROM triggers WHERE id = ?').get(id);
  return row ? toTrigger(row) : null;
}

export function createTrigger(input: TriggerInput): Trigger {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO triggers (id, prompt_id, type, enabled, cron_expression, timezone, config, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.promptId,
    input.type,
    boolToDb(input.enabled),
    input.cronExpression,
    input.timezone,
    JSON.stringify(input.config),
    now,
    now,
  );
  return getTrigger(id)!;
}

export function updateTrigger(id: string, patch: Partial<Trigger>): Trigger | null {
  const columns: Record<string, string> = {
    type: 'type',
    enabled: 'enabled',
    cronExpression: 'cron_expression',
    timezone: 'timezone',
    config: 'config',
    lastFiredAt: 'last_fired_at',
    nextFireAt: 'next_fire_at',
  };
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    if (field === 'config') values.push(JSON.stringify(value));
    else if (field === 'enabled') values.push(boolToDb(Boolean(value)));
    else values.push(value as never);
  }

  if (assignments.length === 0) return getTrigger(id);

  assignments.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE triggers SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getTrigger(id);
}

export function deleteTrigger(id: string): boolean {
  return db.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes > 0;
}

export function markFired(id: string, firedAt: string, nextFireAt: string | null): void {
  db.prepare('UPDATE triggers SET last_fired_at = ?, next_fire_at = ?, updated_at = ? WHERE id = ?').run(
    firedAt,
    nextFireAt,
    new Date().toISOString(),
    id,
  );
}
