import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-stats-'));
process.env.DATA_DIR = tmpDir;

const { migrate, db } = await import('../src/db.js');
const promptStore = await import('../src/store/prompts.js');
const runStore = await import('../src/store/runs.js');
const { totalsSince } = await import('../src/store/stats.js');

before(() => migrate());
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makePrompt() {
  return promptStore.createPrompt({
    kind: 'scheduled',
    title: null,
    name: 'stats-prompt',
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
    repoUrl: null,
    repoRef: null,
  });
}

/**
 * The overview's one summary of how the work is going. A pod restart is a
 * deploy or a node drain rather than the task failing, and the app already
 * draws that line everywhere else — `RESTART_REASON` exists for it, and the
 * goal loop refuses to count one against a goal. Counted as failures here,
 * they made an instance that simply redeploys often look like one that was
 * broken a third of the time.
 */
test('a run a restart cut short is counted apart from a run that failed', () => {
  const prompt = makePrompt();
  const add = (patch: string) => {
    const run = runStore.createRun({
      promptId: prompt.id,
      promptName: prompt.name,
      triggerId: null,
      triggerType: 'manual',
      promptText: 'work',
    });
    db.prepare(`UPDATE runs SET ${patch} WHERE id = ?`).run(run.id);
  };

  add("status = 'succeeded'");
  add("status = 'succeeded'");
  add("status = 'failed'");
  add("status = 'timeout'");
  add("status = 'rate_limited'");
  // Two the process was restarted out of, exactly as failOrphanedRuns leaves them.
  add("status = 'failed', completion_reason = 'restart'");
  add("status = 'failed', completion_reason = 'restart'");

  const totals = totalsSince(null);

  assert.equal(totals.runs, 7);
  assert.equal(totals.succeeded, 2);
  // The genuine failure and the timeout, and neither of the restarts.
  assert.equal(totals.failed, 2, 'a restart is not a failure');
  assert.equal(totals.interrupted, 2, 'but it is still counted, not discarded');
  assert.equal(totals.rateLimited, 1);
});

test('a failure that happens to carry another reason is still a failure', () => {
  // Only 'restart' is exempt. A run stopped by a ceiling had something go
  // wrong with the shape of the task, and should not be quietly reclassified
  // along with the deploys.
  const before = totalsSince(null);
  const prompt = promptStore.getPrompt(
    runStore.listRuns({ limit: 1 })[0]!.promptId,
  )!;
  const run = runStore.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: null,
    triggerType: 'manual',
    promptText: 'work',
  });
  db.prepare("UPDATE runs SET status = 'failed', completion_reason = 'turn-cap' WHERE id = ?").run(run.id);

  const after = totalsSince(null);
  assert.equal(after.failed, before.failed + 1);
  assert.equal(after.interrupted, before.interrupted);
});
