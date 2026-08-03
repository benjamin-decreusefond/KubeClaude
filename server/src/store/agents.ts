import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db, jsonFromDb } from '../db.js';
import type { AgentDefinition } from '../types.js';

interface AgentRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

function toAgent(row: AgentRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: boolFromDb(row.enabled),
    config: row.config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type AgentInput = Omit<AgentDefinition, 'id' | 'createdAt' | 'updatedAt'>;

export function listAgents(): AgentDefinition[] {
  return db
    .prepare<[], AgentRow>('SELECT * FROM agents ORDER BY name COLLATE NOCASE')
    .all()
    .map(toAgent);
}

export function getAgent(id: string): AgentDefinition | null {
  const row = db.prepare<[string], AgentRow>('SELECT * FROM agents WHERE id = ?').get(id);
  return row ? toAgent(row) : null;
}

export function createAgent(input: AgentInput): AgentDefinition {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO agents (id, name, description, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.description, boolToDb(input.enabled), input.config, now, now);
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: Partial<AgentInput>): AgentDefinition | null {
  const columns: Record<string, string> = {
    name: 'name',
    description: 'description',
    enabled: 'enabled',
    config: 'config',
  };
  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const column = columns[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    values.push(field === 'enabled' ? boolToDb(Boolean(value)) : value);
  }
  if (assignments.length === 0) return getAgent(id);
  assignments.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE agents SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getAgent(id);
}

/**
 * Remove an agent, and the references to it.
 *
 * A run silently skips an agent id it cannot find, so a stale one is harmless
 * at run time — but the prompt would keep claiming a subagent that no longer
 * exists, which the editor and the prompt list would both repeat.
 */
export function deleteAgent(id: string): boolean {
  return db.transaction(() => {
    const removed = db.prepare('DELETE FROM agents WHERE id = ?').run(id).changes > 0;
    if (!removed) return false;

    const holders = db
      .prepare<[string], { id: string; agent_ids: string }>(
        "SELECT id, agent_ids FROM prompts WHERE agent_ids LIKE '%' || ? || '%'",
      )
      .all(id);
    const update = db.prepare('UPDATE prompts SET agent_ids = ?, updated_at = ? WHERE id = ?');
    for (const holder of holders) {
      const ids = jsonFromDb<string[]>(holder.agent_ids, []).filter((held) => held !== id);
      update.run(JSON.stringify(ids), new Date().toISOString(), holder.id);
    }
    return true;
  })();
}

/**
 * Build the JSON document for a run's `--agents` flag: the selected shared
 * agents first, then the prompt's inline `agentsJson`, which wins on a name
 * collision — the same precedence `buildMcpDocument` uses for `.mcp.json`.
 */
export function buildAgentsDocument(agentIds: string[], inlineJson: string | null): string | null {
  const agents: Record<string, unknown> = {};

  for (const id of agentIds) {
    const agent = getAgent(id);
    if (!agent || !agent.enabled) continue;
    try {
      const parsed = JSON.parse(agent.config) as Record<string, unknown>;
      // Accept both a bare definition (wrapped under the agent's own name) and
      // a full { name: {...} } document.
      const isBareDefinition = 'prompt' in parsed || 'description' in parsed;
      if (isBareDefinition) agents[agent.name] = parsed;
      else Object.assign(agents, parsed);
    } catch {
      /* an unparseable stored config is skipped rather than breaking the run */
    }
  }

  if (inlineJson?.trim()) {
    try {
      Object.assign(agents, JSON.parse(inlineJson) as Record<string, unknown>);
    } catch {
      /* validated on write, so this should not happen */
    }
  }

  if (Object.keys(agents).length === 0) return null;
  return JSON.stringify(agents);
}
