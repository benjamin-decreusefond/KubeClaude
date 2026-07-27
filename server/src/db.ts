import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

export const db = openDatabase(config.dbPath);

function openDatabase(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = new Database(file);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  handle.pragma('busy_timeout = 5000');
  return handle;
}

const MIGRATIONS: Array<{ name: string; up: string }> = [
  {
    name: '001_initial',
    up: `
      CREATE TABLE prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        model TEXT,
        working_dir TEXT,
        permission_mode TEXT NOT NULL DEFAULT 'default',
        allowed_tools TEXT NOT NULL DEFAULT '[]',
        disallowed_tools TEXT NOT NULL DEFAULT '[]',
        append_system_prompt TEXT,
        max_turns INTEGER,
        timeout_seconds INTEGER NOT NULL DEFAULT 1800,
        env TEXT NOT NULL DEFAULT '{}',
        mcp_config TEXT,
        mcp_server_ids TEXT NOT NULL DEFAULT '[]',
        settings_json TEXT,
        claude_md TEXT,
        continue_session INTEGER NOT NULL DEFAULT 0,
        last_session_id TEXT,
        auto_resume INTEGER NOT NULL DEFAULT 1,
        max_auto_resumes INTEGER NOT NULL DEFAULT 5,
        resume_prompt TEXT,
        completion_check TEXT NOT NULL DEFAULT 'marker',
        completion_marker TEXT,
        judge_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE triggers (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_expression TEXT,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        config TEXT NOT NULL DEFAULT '{}',
        last_fired_at TEXT,
        next_fire_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_triggers_prompt ON triggers(prompt_id);

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        prompt_name TEXT NOT NULL,
        trigger_id TEXT,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        queued_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        duration_ms INTEGER,
        session_id TEXT,
        exit_code INTEGER,
        error TEXT,
        num_turns INTEGER,
        cost_usd REAL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        result_text TEXT,
        model TEXT,
        model_usage TEXT,
        duration_api_ms INTEGER,
        service_tier TEXT,
        resume_of_run_id TEXT,
        root_run_id TEXT NOT NULL,
        follow_up_text TEXT,
        resume_attempt INTEGER NOT NULL DEFAULT 0,
        rate_limit_reset_at TEXT,
        auto_resume_pending INTEGER NOT NULL DEFAULT 0,
        /* NULL until a completion check runs; 1 means the task was finished. */
        completed INTEGER,
        completion_reason TEXT
      );
      CREATE INDEX idx_runs_prompt ON runs(prompt_id, queued_at DESC);
      CREATE INDEX idx_runs_status ON runs(status);
      CREATE INDEX idx_runs_queued ON runs(queued_at DESC);
      CREATE INDEX idx_runs_resume ON runs(auto_resume_pending) WHERE auto_resume_pending = 1;
      CREATE INDEX idx_runs_thread ON runs(root_run_id, queued_at);

      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        /* The server entry exactly as it appears under "mcpServers" in .mcp.json. */
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE run_events (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      );

      CREATE TABLE usage_windows (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        run_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_windows_kind ON usage_windows(kind, ends_at DESC);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

export function migrate(): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare<[], { name: string }>('SELECT name FROM schema_migrations').all().map((r) => r.name),
  );

  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.name, new Date().toISOString());
    })();
  }
}

export function boolFromDb(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}

export function boolToDb(value: boolean): number {
  return value ? 1 : 0;
}

export function jsonFromDb<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
