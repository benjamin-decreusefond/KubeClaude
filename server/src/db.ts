import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { logger } from './logger.js';

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
  {
    name: '002_chats',
    up: `
      /*
       * A chat is a prompt you talk to instead of scheduling. Same execution
       * path, same threading, same quota accounting — it just does not appear
       * in the prompt list and carries a display title instead of a name.
       */
      ALTER TABLE prompts ADD COLUMN kind TEXT NOT NULL DEFAULT 'scheduled';
      ALTER TABLE prompts ADD COLUMN title TEXT;
      CREATE INDEX idx_prompts_kind ON prompts(kind, updated_at DESC);
    `,
  },
  {
    name: '003_goals',
    up: `
      /*
       * A goal owns a prompt (kind 'goal') and drives it in a loop: the prompt
       * holds the model, the tools and the session, the goal holds the
       * objectives and the progress. Deleting the goal deletes the prompt with
       * it, which is why the FK sits on this side.
       */
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        objectives TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        cadence_minutes INTEGER NOT NULL DEFAULT 30,
        max_iterations INTEGER NOT NULL DEFAULT 0,
        iteration INTEGER NOT NULL DEFAULT 0,
        stop_when_achieved INTEGER NOT NULL DEFAULT 1,
        review_model TEXT,
        last_run_id TEXT,
        last_iteration_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX idx_goals_prompt ON goals(prompt_id);
      CREATE INDEX idx_goals_status ON goals(status, updated_at DESC);

      /* The progress log: one row per finished iteration, oldest first. */
      CREATE TABLE goal_iterations (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        run_id TEXT,
        created_at TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        next_step TEXT,
        achieved TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'none',
        run_status TEXT
      );
      CREATE INDEX idx_goal_iterations ON goal_iterations(goal_id, seq);
      /* A run is reviewed exactly once, however often the sweep sees it. */
      CREATE UNIQUE INDEX idx_goal_iterations_run ON goal_iterations(run_id) WHERE run_id IS NOT NULL;
    `,
  },
  {
    name: '004_auth',
    up: `
      /*
       * One row, id 1. There is a single operator account: this is a tool you
       * run for yourself, and a user table would imply roles that do not exist.
       */
      CREATE TABLE auth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        method TEXT NOT NULL DEFAULT 'forms',
        requirement TEXT NOT NULL DEFAULT 'always',
        external_user_header TEXT NOT NULL DEFAULT 'X-Forwarded-User',
        username TEXT NOT NULL DEFAULT '',
        /* scrypt, with its parameters and salt encoded alongside the digest. */
        password_hash TEXT,
        /* Hashed like a password would be: a leaked backup must not hand it over. */
        api_key_hash TEXT,
        session_days INTEGER NOT NULL DEFAULT 30,
        updated_at TEXT NOT NULL
      );

      /*
       * Sessions live in the database rather than in a signed cookie so that
       * signing out, changing the password, or switching auth method can revoke
       * them for real.
       */
      CREATE TABLE auth_sessions (
        /* SHA-256 of the cookie value; the value itself is never stored. */
        token_hash TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        user_agent TEXT
      );
      CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);
    `,
  },
  {
    name: '005_errors',
    up: `
      /*
       * Things that went wrong where nobody was watching: a request that threw,
       * a rejection nothing handled, a browser that failed to render. They used
       * to go to stdout and to nowhere respectively, which is fine for a person
       * with a terminal open and useless for a loop asked to "fix the bugs".
       *
       * One row per distinct error rather than per occurrence — a broken poll
       * fires every fifteen seconds, and a feed it floods is a feed nobody
       * reads.
       */
      CREATE TABLE app_errors (
        id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        message TEXT NOT NULL,
        detail TEXT,
        context TEXT,
        count INTEGER NOT NULL DEFAULT 1,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE INDEX idx_app_errors_seen ON app_errors(last_seen_at DESC);
    `,
  },
  {
    name: '006_repositories',
    up: `
      /*
       * A prompt can name a repository to work in. KubeClaude clones it on the
       * first run and puts the working directory back on the remote before
       * every run after that, so a prompt is about the change it wants rather
       * than about remembering how to get a checkout.
       */
      ALTER TABLE prompts ADD COLUMN repo_url TEXT;
      ALTER TABLE prompts ADD COLUMN repo_ref TEXT;
    `,
  },
  {
    name: '007_execution_controls',
    up: `
      /*
       * Flags the CLI has and this app could not reach: a fallback chain for
       * when the chosen model is overloaded, an effort level, a dollar ceiling
       * the CLI enforces on itself, and extra directories a run may touch.
       * All optional — an existing prompt keeps behaving exactly as it did.
       */
      ALTER TABLE prompts ADD COLUMN fallback_model TEXT;
      ALTER TABLE prompts ADD COLUMN effort TEXT;
      ALTER TABLE prompts ADD COLUMN max_budget_usd REAL;
      ALTER TABLE prompts ADD COLUMN add_dirs TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    name: '008_context_controls',
    up: `
      /*
       * What a run is made of, rather than what it spends: a system prompt that
       * replaces the CLI's own, custom subagents, the built-in tool set, and
       * which settings files are read. All NULL by default, and NULL means
       * "leave the CLI alone" everywhere — an empty list is a different thing
       * from an absent one, which is why builtin_tools is nullable JSON rather
       * than a defaulted array.
       */
      ALTER TABLE prompts ADD COLUMN system_prompt TEXT;
      ALTER TABLE prompts ADD COLUMN agents_json TEXT;
      ALTER TABLE prompts ADD COLUMN builtin_tools TEXT;
      ALTER TABLE prompts ADD COLUMN setting_sources TEXT;
    `,
  },
  {
    name: '009_quota_resets',
    up: `
      /*
       * When Claude says the allowance comes back.
       *
       * A usage window's ends_at used to be a guess: started_at plus five
       * hours, anchored on the first run KubeClaude happened to book. Claude's
       * real window is anchored on the first message of the session wherever it
       * was sent — the desktop app, a terminal, another machine — so the two
       * drift apart, and a "new 5h session" trigger built on the guess is a
       * five-hour cron that is wrong by however far they have drifted.
       *
       * The CLI tells us the truth when it refuses a run: "usage limit
       * reached|<epoch>". That is worth keeping past the run it arrived on, so
       * the window, the gauge and the trigger can all key off the real moment
       * rather than off arithmetic.
       *
       * One row per observation rather than one per window: observations are
       * evidence, and evidence is append-only. The newest still-future row for
       * a kind is the one that counts.
       */
      CREATE TABLE quota_resets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reset_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        /* Where it came from, so a guess can never be mistaken for a fact. */
        source TEXT NOT NULL DEFAULT 'cli',
        run_id TEXT,
        evidence TEXT
      );
      CREATE INDEX idx_quota_resets ON quota_resets(kind, reset_at DESC);
      /* The same reset observed twice is one fact, not two. */
      CREATE UNIQUE INDEX idx_quota_resets_unique ON quota_resets(kind, reset_at);

      /*
       * Set when a window's end came from an observation rather than from
       * duration arithmetic. The gauge says "resets at" either way; only this
       * says whether to believe it to the minute.
       */
      ALTER TABLE usage_windows ADD COLUMN ends_at_observed INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    name: '010_agents_and_webhooks',
    up: `
      /*
       * Shared subagent definitions, the same idea as mcp_servers: defined once,
       * attached to any prompt by name instead of retyping the same reviewer or
       * tester into every prompt's inline --agents JSON.
       */
      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        /* A bare { description, prompt, ... } definition, or a full { name: {...} } document. */
        config TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ALTER TABLE prompts ADD COLUMN agent_ids TEXT NOT NULL DEFAULT '[]';

      /*
       * A webhook trigger has no cron or interval — it fires on an inbound POST
       * carrying this token in the URL. Generated once at creation, and the only
       * credential a third-party caller (Asana, Jira, GitHub, ...) presents.
       */
      ALTER TABLE triggers ADD COLUMN webhook_token TEXT;
    `,
  },
  {
    name: '011_backfill_interrupted_durations',
    up: `
      /*
       * Until recently a run closed out by a restart was given a finished_at and
       * no duration. Null is not read as "unknown" anywhere it lands: the run
       * pages render a dash, as though it took no time, and the dashboard's
       * wall-clock figure is a SUM over the column, which skips nulls outright.
       * The runs a restart catches are the ones that were still going, so the
       * total was missing precisely the longest work.
       *
       * Both timestamps are on the row, so the elapsed time is recoverable
       * exactly rather than estimated. Scoped to the restart rows with a
       * started_at and no duration: a run that legitimately has none — one that
       * never started — is left alone, and so is every run whose duration the
       * queue already recorded.
       */
      UPDATE runs
         SET duration_ms = CAST((julianday(finished_at) - julianday(started_at)) * 86400000 AS INTEGER)
       WHERE completion_reason = 'restart'
         AND duration_ms IS NULL
         AND started_at IS NOT NULL
         AND finished_at IS NOT NULL;
    `,
  },
  {
    name: '012_goal_iteration_instruction',
    up: `
      /*
       * How a goal iterates, in its own words. NULL — which is what every goal
       * stored before this column existed has — means the built-in brief, so
       * the default stays one place in the code rather than being copied into
       * every row at migration time and then frozen there.
       */
      ALTER TABLE goals ADD COLUMN iteration_instruction TEXT;
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

  const pending = MIGRATIONS.filter((migration) => !applied.has(migration.name));
  if (pending.length === 0) return;
  // Nothing to lose on a database that has never been migrated.
  if (applied.size > 0) backupDatabase(pending[0]!.name);

  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)');
  for (const migration of pending) {
    db.transaction(() => {
      db.exec(migration.up);
      record.run(migration.name, new Date().toISOString());
    })();
  }
}

const BACKUP_PREFIX = 'kubeclaude-';
const BACKUP_SUFFIX = '.db';

/**
 * Copy the database before changing its shape.
 *
 * A migration runs at startup, inside a transaction, so a statement that fails
 * rolls back. What does not roll back is a migration that succeeds and leaves
 * the app unable to start — and that is the one failure it cannot dig itself out
 * of, because the thing that would repair it is the thing that is down. A copy
 * on disk turns that into a file swap.
 *
 * `VACUUM INTO` is used rather than a file copy: it takes a read lock and writes
 * a consistent database, WAL included, which `cp` on a live SQLite file does
 * not.
 */
function backupDatabase(nextMigration: string): void {
  let file: string | null = null;
  try {
    fs.mkdirSync(config.backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    file = path.join(config.backupsDir, `${BACKUP_PREFIX}${stamp}-before-${nextMigration}${BACKUP_SUFFIX}`);
    db.prepare('VACUUM INTO ?').run(file);
    pruneBackups();
    logger.info({ file, migration: nextMigration }, 'database backed up before migrating');
  } catch (error) {
    /*
     * A `VACUUM INTO` that runs out of disk part-way leaves the half-written
     * target behind, and the backups directory defaults to the same volume as
     * the database — so the disk filling up is exactly when this happens. Left
     * there, that stub is indistinguishable from a real backup: it is listed as
     * one, and it counts towards `backupsKept`, so a few failed migrations in a
     * row would evict the last copy that could actually be restored.
     */
    if (file) fs.rmSync(file, { force: true });
    // Not fatal on its own: refusing to start because the backup failed would
    // turn "the disk is full" into an outage of its own. Loud, though — this is
    // the safety net going missing.
    logger.error({ err: String(error), dir: config.backupsDir }, 'could not back up the database before migrating');
  }
}

function pruneBackups(): void {
  const files = fs
    .readdirSync(config.backupsDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort();
  for (const name of files.slice(0, Math.max(0, files.length - config.backupsKept))) {
    fs.rmSync(path.join(config.backupsDir, name), { force: true });
  }
}

/** Backups on disk, newest first. Timestamped names sort chronologically. */
export function listBackups(): Array<{ file: string; bytes: number; takenAt: string }> {
  if (!fs.existsSync(config.backupsDir)) return [];
  return fs
    .readdirSync(config.backupsDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
    .sort()
    .reverse()
    .map((name) => {
      const file = path.join(config.backupsDir, name);
      return { file, bytes: fs.statSync(file).size, takenAt: fs.statSync(file).mtime.toISOString() };
    });
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
