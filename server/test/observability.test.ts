import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

/**
 * The three things this app could not tell you about itself: how big an event
 * it had swallowed, whether it had a copy of the database before it changed its
 * shape, and what had gone wrong while nobody was watching.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-observability-'));

process.env.DATA_DIR = tmpDir;
process.env.MAX_EVENT_BYTES = '4096';
process.env.MAX_STORED_ERRORS = '5';

const { migrate, db } = await import('../src/db.js');
const { clampPayload } = await import('../src/store/payload.js');
const promptStore = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const errorStore = await import('../src/store/errors.js');
const { config } = await import('../src/config.js');
import type { Prompt } from '../src/types.js';

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;
function makePrompt(): Prompt {
  counter += 1;
  return promptStore.createPrompt({
    kind: 'scheduled',
    title: null,
    name: `observability-${counter}`,
    description: '',
    prompt: 'do the thing',
    enabled: true,
    model: null,
    workingDir: null,
    permissionMode: 'default',
    allowedTools: [],
    disallowedTools: [],
    appendSystemPrompt: null,
    maxTurns: null,
    timeoutSeconds: 60,
    env: {},
    mcpConfig: null,
    mcpServerIds: [],
    settingsJson: null,
    claudeMd: null,
    continueSession: false,
    autoResume: false,
    maxAutoResumes: 0,
    resumePrompt: null,
    completionCheck: 'never',
    completionMarker: null,
    judgeModel: null,
  });
}

// --------------------------------------------------------------------------
// Event payloads
// --------------------------------------------------------------------------

test('an ordinary payload is stored exactly as it arrived', () => {
  const payload = { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
  const clamped = clampPayload(payload);
  assert.equal(clamped.truncated, false);
  assert.deepEqual(clamped.payload, payload);
});

test('a huge tool result keeps its shape and loses its bulk', () => {
  const payload = {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false, content: 'x'.repeat(2_000_000) },
      ],
    },
  };

  const clamped = clampPayload(payload);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.originalBytes > 2_000_000);
  assert.ok(JSON.stringify(clamped.payload).length <= config.maxEventBytes);

  // What a person reads survives: which message, which tool call, whether it
  // errored, and the beginning of the output.
  const stored = clamped.payload as { type: string; message: { content: Array<Record<string, unknown>> } };
  assert.equal(stored.type, 'user');
  const block = stored.message.content[0]!;
  assert.equal(block.tool_use_id, 'toolu_1');
  assert.equal(block.is_error, false);
  assert.match(String(block.content), /^x+/);
  assert.match(String(block.content), /more characters, not stored/);
});

test('a payload with nothing small in it still says what happened', () => {
  // Thousands of short fields: no single string to cut, so there is nothing to
  // do but record the size and the two labels the log renders from.
  const message: Record<string, string> = {};
  for (let i = 0; i < 20_000; i += 1) message[`field-${i}`] = `value-${i}`;

  const clamped = clampPayload({ type: 'system', subtype: 'init', ...message });
  assert.equal(clamped.truncated, true);
  const stored = clamped.payload as { type: string; subtype: string; truncated: string };
  assert.equal(stored.type, 'system');
  assert.equal(stored.subtype, 'init');
  assert.match(stored.truncated, /MAX_EVENT_BYTES/);
});

test('what is streamed to a watcher is what a reload will show', () => {
  const prompt = makePrompt();
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'manual',
    promptText: 'go',
  });

  const event = runStore.appendEvent(run.id, 'message', { type: 'user', text: 'y'.repeat(500_000) })!;
  const [reloaded] = runStore.listEvents(run.id);

  assert.deepEqual(reloaded?.payload, event.payload);
  assert.ok(JSON.stringify(event.payload).length <= config.maxEventBytes);
});

// --------------------------------------------------------------------------
// Backups
// --------------------------------------------------------------------------

test('a database that already has a schema is copied before it is migrated', async () => {
  const { listBackups } = await import('../src/db.js');
  assert.deepEqual(listBackups(), [], 'a first migration has nothing to lose');

  // Put the database back one migration, the way an older instance would be
  // when a new image lands on it.
  db.exec('DROP TABLE app_errors');
  db.prepare("DELETE FROM schema_migrations WHERE name = '005_errors'").run();

  migrate();

  const backups = listBackups();
  assert.equal(backups.length, 1);
  assert.match(backups[0]!.file, /before-005_errors/);
  assert.ok(backups[0]!.bytes > 0);

  // And it is a real database, not a truncated file: the copy still answers.
  const { default: Database } = await import('better-sqlite3');
  const copy = new Database(backups[0]!.file, { readonly: true });
  const names = copy
    .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  copy.close();
  assert.ok(names.includes('runs'));
  // Taken before the migration, so the new table is precisely what it lacks.
  assert.ok(!names.includes('app_errors'));

  // The migration it was taken for still applied.
  assert.equal(errorStore.countErrors(), 0);
});

test('the durations restarts used to leave behind are worked out from the timestamps', () => {
  const prompt = makePrompt();
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'manual',
    promptText: 'work',
  });

  // A row as older instances left it: closed out by a restart, both timestamps
  // written, and no duration — which the run pages render as a dash and the
  // dashboard's SUM skips entirely.
  db.prepare(
    `UPDATE runs SET status = 'failed', completion_reason = 'restart', duration_ms = NULL,
       started_at = '2026-08-04T07:48:21.341Z', finished_at = '2026-08-04T07:48:48.033Z'
     WHERE id = ?`,
  ).run(run.id);

  // Put the database back one migration, the way an older instance would be.
  db.prepare("DELETE FROM schema_migrations WHERE name = '011_backfill_interrupted_durations'").run();
  migrate();

  // 26.692 seconds, recovered exactly rather than estimated. SQLite works this
  // out in floating-point days, so allow it the odd millisecond.
  const repaired = runStore.getRun(run.id)!;
  assert.ok(repaired.durationMs !== null, 'the backfill should have filled this in');
  assert.ok(
    Math.abs(repaired.durationMs - 26_692) <= 2,
    `expected about 26692ms, got ${repaired.durationMs}`,
  );
});

test('the backfill leaves alone what it has no business touching', () => {
  const prompt = makePrompt();
  const make = (patch: string) => {
    const run = runStore.createRun({
      promptId: prompt.id,
      promptName: prompt.name,
      triggerId: null,
      triggerType: 'manual',
      promptText: 'work',
    });
    db.prepare(`UPDATE runs SET ${patch} WHERE id = ?`).run(run.id);
    return run.id;
  };

  // A duration the queue already recorded, on a restart row: not the
  // backfill's to overwrite.
  const recorded = make(
    "completion_reason = 'restart', duration_ms = 999, " +
      "started_at = '2026-08-04T07:48:21.341Z', finished_at = '2026-08-04T07:48:48.033Z'",
  );
  // A run that never started, where having no duration is the honest answer.
  const neverStarted = make("completion_reason = 'restart', duration_ms = NULL, started_at = NULL");
  // And an ordinary failure, which is not a restart at all.
  const ordinaryFailure = make(
    "status = 'failed', completion_reason = NULL, duration_ms = NULL, " +
      "started_at = '2026-08-04T07:48:21.341Z', finished_at = '2026-08-04T07:48:48.033Z'",
  );

  db.prepare("DELETE FROM schema_migrations WHERE name = '011_backfill_interrupted_durations'").run();
  migrate();

  assert.equal(runStore.getRun(recorded)!.durationMs, 999);
  assert.equal(runStore.getRun(neverStarted)!.durationMs, null);
  assert.equal(runStore.getRun(ordinaryFailure)!.durationMs, null);
});

// --------------------------------------------------------------------------
// The error feed
// --------------------------------------------------------------------------

test('the same fault from the same place is counted, not repeated', () => {
  const detail = 'TypeError: x is not a function\n    at drain (/app/queue.js:12:3)';
  for (let i = 0; i < 5; i += 1) {
    errorStore.recordError({ source: 'server', message: 'x is not a function', detail, context: 'POST /api/runs' });
  }

  const [entry] = errorStore.listErrors();
  assert.equal(errorStore.countErrors(), 1);
  assert.equal(entry?.count, 5);
  assert.ok(entry.firstSeenAt <= entry.lastSeenAt);
});

test('the same message from a different place stays a separate fault', () => {
  errorStore.clearErrors();
  const message = 'fetch failed';
  errorStore.recordError({ source: 'server', message, detail: 'Error\n    at poll (/app/a.js:1:1)' });
  errorStore.recordError({ source: 'server', message, detail: 'Error\n    at sweep (/app/b.js:1:1)' });

  // Usually two bugs that happen to read alike, and folding them would hide one.
  assert.equal(errorStore.countErrors(), 2);
});

test('the feed cannot grow past its ceiling', () => {
  errorStore.clearErrors();
  for (let i = 0; i < 40; i += 1) {
    errorStore.recordError({ source: 'run', message: `failure ${i}`, context: `run-${i}` });
  }

  assert.equal(errorStore.countErrors(), config.maxStoredErrors);
  // What survives is what happened most recently.
  assert.equal(errorStore.listErrors()[0]?.message, 'failure 39');
});

test('a stack too long to be useful is clipped rather than stored whole', () => {
  errorStore.clearErrors();
  const entry = errorStore.recordError({
    source: 'browser',
    message: 'boom',
    detail: 'z'.repeat(50_000),
    context: '/runs',
  })!;

  assert.ok(entry.detail!.length < 5_000, `detail was ${entry.detail!.length} characters`);
  assert.equal(errorStore.recordError({ source: 'browser', message: '   ' }), null);
});
