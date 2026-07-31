import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db } from '../db.js';
import type { McpServer } from '../types.js';

interface McpRow {
  id: string;
  name: string;
  description: string;
  enabled: number;
  config: string;
  created_at: string;
  updated_at: string;
}

function toServer(row: McpRow): McpServer {
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

export type McpServerInput = Omit<McpServer, 'id' | 'createdAt' | 'updatedAt'>;

export function listMcpServers(): McpServer[] {
  return db
    .prepare<[], McpRow>('SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE')
    .all()
    .map(toServer);
}

export function getMcpServer(id: string): McpServer | null {
  const row = db.prepare<[string], McpRow>('SELECT * FROM mcp_servers WHERE id = ?').get(id);
  return row ? toServer(row) : null;
}

export function createMcpServer(input: McpServerInput): McpServer {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO mcp_servers (id, name, description, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, input.name, input.description, boolToDb(input.enabled), input.config, now, now);
  return getMcpServer(id)!;
}

export function updateMcpServer(id: string, patch: Partial<McpServerInput>): McpServer | null {
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
    values.push(field === 'enabled' ? boolToDb(Boolean(value)) : (value));
  }
  if (assignments.length === 0) return getMcpServer(id);
  assignments.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE mcp_servers SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getMcpServer(id);
}

export function deleteMcpServer(id: string): boolean {
  return db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
}

/**
 * Build the `.mcp.json` document for a run: the selected shared servers first,
 * then the prompt's inline config, which wins on a name collision.
 *
 * `${VAR}` placeholders are left untouched — the CLI expands them from the run's
 * environment, which is how a token reaches an MCP server without being stored
 * in this database.
 */
export function buildMcpDocument(serverIds: string[], inlineConfig: string | null): string | null {
  const mcpServers: Record<string, unknown> = {};

  for (const id of serverIds) {
    const server = getMcpServer(id);
    if (!server || !server.enabled) continue;
    try {
      const parsed = JSON.parse(server.config) as Record<string, unknown>;
      // Accept both a bare server entry and a full { mcpServers: {...} } document.
      const entries = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {
        [server.name]: parsed,
      };
      for (const [name, entry] of Object.entries(entries)) mcpServers[name] = entry;
    } catch {
      /* an unparseable stored config is skipped rather than breaking the run */
    }
  }

  if (inlineConfig?.trim()) {
    try {
      const parsed = JSON.parse(inlineConfig) as Record<string, unknown>;
      const entries = (parsed.mcpServers as Record<string, unknown> | undefined) ?? parsed;
      for (const [name, entry] of Object.entries(entries)) mcpServers[name] = entry;
    } catch {
      /* validated on write, so this should not happen */
    }
  }

  if (Object.keys(mcpServers).length === 0) return null;
  return JSON.stringify({ mcpServers }, null, 2);
}
