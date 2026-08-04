import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { signIn, startTestApp, type TestApp } from './helpers/app.js';

/**
 * The API as a client meets it: through the auth hook, the schemas and the
 * routes, rather than by calling stores directly. `config` and `db` read the
 * environment once at import, so a process holds exactly one instance — every
 * test here shares this one and the order is deliberate.
 */
let kube: TestApp;
let apiKey = '';

before(async () => {
  kube = await startTestApp();
});

after(async () => {
  await kube.close();
});

test('before setup, the API is shut and says how to open it', async () => {
  const prompts = await kube.request({ method: 'GET', url: '/api/prompts' });
  assert.equal(prompts.status, 401);
  assert.equal(prompts.json<{ setupRequired: boolean }>().setupRequired, true);

  // The probes have to answer regardless, or Kubernetes kills the pod that is
  // waiting for somebody to set a password.
  assert.equal((await kube.request({ method: 'GET', url: '/healthz' })).status, 200);
  assert.equal((await kube.request({ method: 'GET', url: '/readyz' })).status, 200);

  const state = await kube.request({ method: 'GET', url: '/api/auth/state' });
  assert.equal(state.status, 200);
  assert.equal(state.json<{ setupRequired: boolean }>().setupRequired, true);
});

test('setup opens the API and hands over an API key', async () => {
  const result = await signIn(kube);
  apiKey = result.apiKey;
  assert.ok(apiKey.length > 20);

  assert.equal((await kube.request({ method: 'GET', url: '/api/prompts' })).status, 200);

  // The key works on its own, without the cookie the browser is carrying.
  const asMachine = kube.as(apiKey);
  assert.equal((await asMachine({ method: 'GET', url: '/api/prompts' })).status, 200);
});

test('an unknown API route is a 404, not the SPA', async () => {
  const response = await kube.request({ method: 'GET', url: '/api/nope' });
  assert.equal(response.status, 404);
});

// --------------------------------------------------------------------------
// Prompts
// --------------------------------------------------------------------------

let promptId = '';

test('a prompt can be created, read back, listed and changed', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'nightly-review',
      description: 'Look at the open PRs',
      prompt: 'Review the open pull requests and merge the green ones',
      model: 'claude-sonnet-5',
      timeoutSeconds: 600,
    },
  });
  assert.equal(created.status, 201);
  const prompt = created.json<{ id: string; name: string; permissionMode: string; enabled: boolean }>();
  promptId = prompt.id;
  assert.equal(prompt.name, 'nightly-review');
  // Defaults the schema is responsible for.
  assert.equal(prompt.permissionMode, 'default');
  assert.equal(prompt.enabled, true);

  const listed = await kube.request({ method: 'GET', url: '/api/prompts' });
  assert.equal(listed.status, 200);
  const list = listed.json<Array<{ id: string; triggers: unknown[]; lastRun: unknown }>>();
  assert.equal(list.length, 1);
  // The list view carries what the page needs, not just the row.
  assert.deepEqual(list[0]?.triggers, []);
  assert.equal(list[0]?.lastRun, null);

  const patched = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${promptId}`,
    payload: { description: 'Changed', enabled: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json<{ description: string; enabled: boolean }>().enabled, false);

  await kube.request({ method: 'PATCH', url: `/api/prompts/${promptId}`, payload: { enabled: true } });
});

test('a prompt can be duplicated, with a fresh name and no triggers', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'duplicate-me',
      description: 'Original',
      prompt: 'Do the original thing',
      model: 'claude-sonnet-5',
      env: { FOO: 'bar' },
    },
  });
  const original = created.json<{ id: string }>();

  await kube.request({
    method: 'POST',
    url: `/api/prompts/${original.id}/triggers`,
    payload: { type: 'interval', config: { intervalMinutes: 30 } },
  });

  const duplicated = await kube.request({ method: 'POST', url: `/api/prompts/${original.id}/duplicate` });
  assert.equal(duplicated.status, 201);
  const copy = duplicated.json<{
    id: string;
    name: string;
    prompt: string;
    env: Record<string, string>;
    triggers: unknown[];
  }>();

  assert.notEqual(copy.id, original.id);
  assert.equal(copy.name, 'duplicate-me (copy)');
  assert.equal(copy.prompt, 'Do the original thing');
  assert.deepEqual(copy.env, { FOO: 'bar' });

  // The interval trigger stays with the prompt it was firing, not the copy.
  const copyTriggers = await kube.request({ method: 'GET', url: `/api/prompts/${copy.id}/triggers` });
  assert.deepEqual(copyTriggers.json(), []);

  // A second duplicate does not collide with the first.
  const again = await kube.request({ method: 'POST', url: `/api/prompts/${original.id}/duplicate` });
  assert.equal(again.json<{ name: string }>().name, 'duplicate-me (copy 2)');

  const missing = await kube.request({ method: 'POST', url: '/api/prompts/does-not-exist/duplicate' });
  assert.equal(missing.status, 404);

  await kube.request({ method: 'DELETE', url: `/api/prompts/${original.id}` });
  await kube.request({ method: 'DELETE', url: `/api/prompts/${copy.id}` });
  await kube.request({ method: 'DELETE', url: `/api/prompts/${again.json<{ id: string }>().id}` });
});

test('a prompt exports as portable JSON that imports straight back through create', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'export-me',
      description: 'Round-trips',
      prompt: 'Do the exported thing',
      model: 'claude-sonnet-5',
      env: { FOO: 'bar' },
    },
  });
  const original = created.json<{ id: string }>();

  const exported = await kube.request({ method: 'GET', url: `/api/prompts/${original.id}/export` });
  assert.equal(exported.status, 200);
  assert.match(String(exported.headers['content-disposition']), /attachment; filename="export-me\.json"/);
  const portable = exported.json<{
    id?: string;
    kind?: string;
    title?: string;
    name: string;
    prompt: string;
    env: Record<string, string>;
  }>();

  // Nothing that would be meaningless — or a collision — anywhere else.
  assert.equal(portable.id, undefined);
  assert.equal(portable.kind, undefined);
  assert.equal(portable.title, undefined);
  assert.equal(portable.env.FOO, 'bar');

  // The exported shape is exactly what creating a prompt accepts back.
  const imported = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { ...portable, name: 'imported-from-export' },
  });
  assert.equal(imported.status, 201);
  const reimported = imported.json<{ id: string; prompt: string; env: Record<string, string> }>();
  assert.equal(reimported.prompt, 'Do the exported thing');
  assert.deepEqual(reimported.env, { FOO: 'bar' });

  const missing = await kube.request({ method: 'GET', url: '/api/prompts/does-not-exist/export' });
  assert.equal(missing.status, 404);

  await kube.request({ method: 'DELETE', url: `/api/prompts/${original.id}` });
  await kube.request({ method: 'DELETE', url: `/api/prompts/${reimported.id}` });
});

test('the CLI execution controls round-trip through the API', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'execution-controls',
      prompt: 'Do the thing',
      fallbackModel: 'sonnet,haiku',
      effort: 'xhigh',
      maxBudgetUsd: 3,
      addDirs: ['/data/other'],
      permissionMode: 'auto',
    },
  });
  assert.equal(created.status, 201);
  const prompt = created.json<{
    id: string;
    fallbackModel: string;
    effort: string;
    maxBudgetUsd: number;
    addDirs: string[];
    permissionMode: string;
  }>();
  assert.equal(prompt.fallbackModel, 'sonnet,haiku');
  assert.equal(prompt.effort, 'xhigh');
  assert.equal(prompt.maxBudgetUsd, 3);
  assert.deepEqual(prompt.addDirs, ['/data/other']);
  assert.equal(prompt.permissionMode, 'auto');

  const reread = await kube.request({ method: 'GET', url: `/api/prompts/${prompt.id}` });
  assert.deepEqual(reread.json<{ addDirs: string[] }>().addDirs, ['/data/other']);

  await kube.request({ method: 'DELETE', url: `/api/prompts/${prompt.id}` });
});

test('the context controls round-trip, empty tool set included', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'context-controls',
      prompt: 'Do the thing',
      systemPrompt: 'You are a release engineer.',
      agentsJson: '{"reviewer":{"description":"Reviews code","prompt":"You review"}}',
      builtinTools: [],
      settingSources: 'none',
    },
  });
  assert.equal(created.status, 201);
  const prompt = created.json<{ id: string; builtinTools: string[] | null; settingSources: string }>();
  // The distinction the whole encoding exists for: [] survives as [], not null.
  assert.deepEqual(prompt.builtinTools, []);
  assert.equal(prompt.settingSources, 'none');

  const narrowed = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${prompt.id}`,
    payload: { builtinTools: ['Bash', 'Read'] },
  });
  assert.deepEqual(narrowed.json<{ builtinTools: string[] }>().builtinTools, ['Bash', 'Read']);

  const cleared = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${prompt.id}`,
    payload: { builtinTools: null },
  });
  assert.equal(cleared.json<{ builtinTools: string[] | null }>().builtinTools, null);

  await kube.request({ method: 'DELETE', url: `/api/prompts/${prompt.id}` });
});

test('a context control the CLI would not accept is refused', async () => {
  for (const payload of [
    { settingSources: 'everything' },
    { builtinTools: ['Bash(rm -rf /)'] },
    { agentsJson: 'not json' },
  ]) {
    const response = await kube.request({
      method: 'POST',
      url: '/api/prompts',
      payload: { name: `bad-context-${JSON.stringify(payload).length}`, prompt: 'x', ...payload },
    });
    assert.equal(response.status, 400, `should refuse ${JSON.stringify(payload)}`);
  }
});

test('an execution control the CLI would not accept is refused', async () => {
  for (const payload of [
    { effort: 'extreme' },
    // A relative path resolves against a working directory that differs per
    // prompt, and a leading dash would arrive at the CLI as a flag.
    { addDirs: ['relative/path'] },
    { addDirs: ['--dangerously-skip-permissions'] },
    { fallbackModel: 'sonnet;rm -rf /' },
  ]) {
    const response = await kube.request({
      method: 'POST',
      url: '/api/prompts',
      payload: { name: `bad-${JSON.stringify(payload).length}`, prompt: 'x', ...payload },
    });
    assert.equal(response.status, 400, `should refuse ${JSON.stringify(payload)}`);
  }
});

test('an invalid prompt is refused with the reason', async () => {
  const response = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: '', prompt: '' },
  });
  assert.equal(response.status, 400);
  assert.match(response.json<{ error: string }>().error, /Invalid prompt/);
});

test('a turn cap of zero is accepted, because zero is how a prompt opts out', async () => {
  // The runner already treats 0 as "uncapped on purpose" and the editor tells
  // you to type it, but the schema used to demand a positive number — so the
  // documented escape hatch could not be set through the API at all.
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: 'uncapped', prompt: 'run as long as it takes', maxTurns: 0 },
  });
  assert.equal(created.status, 201);
  const { id } = created.json<{ id: string }>();

  // Round-trips as 0 rather than collapsing into null, which would silently
  // mean "inherit the default" — the opposite of what was asked for.
  assert.equal(created.json<{ maxTurns: number | null }>().maxTurns, 0);

  const patched = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${id}`,
    payload: { maxTurns: 0 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json<{ maxTurns: number | null }>().maxTurns, 0);

  // Still a cap, not a free-for-all: negatives and the ceiling stay refused.
  for (const maxTurns of [-1, 1001]) {
    const refused = await kube.request({
      method: 'POST',
      url: '/api/prompts',
      payload: { name: `bad-cap-${maxTurns}`, prompt: 'x', maxTurns },
    });
    assert.equal(refused.status, 400, `should refuse maxTurns ${maxTurns}`);
  }

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/prompts/${id}` })).status, 204);
});

test('a duplicate prompt name is a conflict, not a crash', async () => {
  const response = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: 'nightly-review', prompt: 'Something else' },
  });
  assert.equal(response.status, 409);
});

test('a missing prompt is a 404 on every verb', async () => {
  for (const [method, url] of [
    ['GET', '/api/prompts/missing'],
    ['PATCH', '/api/prompts/missing'],
    ['DELETE', '/api/prompts/missing'],
    ['POST', '/api/prompts/missing/run'],
  ] as const) {
    const response = await kube.request({ method, url, payload: method === 'GET' ? undefined : {} });
    assert.equal(response.status, 404, `${method} ${url}`);
  }
});

// --------------------------------------------------------------------------
// Triggers
// --------------------------------------------------------------------------

test('triggers are created under their prompt and validated by type', async () => {
  const created = await kube.request({
    method: 'POST',
    url: `/api/prompts/${promptId}/triggers`,
    payload: { type: 'interval', config: { intervalMinutes: 30 } },
  });
  assert.equal(created.status, 201);
  const trigger = created.json<{ id: string; type: string; timezone: string }>();
  assert.equal(trigger.type, 'interval');
  // The timezone falls back to the instance setting rather than being required.
  assert.ok(trigger.timezone);

  // A cron trigger without an expression could never fire; refuse it up front.
  const bad = await kube.request({
    method: 'POST',
    url: `/api/prompts/${promptId}/triggers`,
    payload: { type: 'cron' },
  });
  assert.equal(bad.status, 400);

  const listed = await kube.request({ method: 'GET', url: `/api/prompts/${promptId}/triggers` });
  assert.equal(listed.json<unknown[]>().length, 1);

  const patched = await kube.request({
    method: 'PATCH',
    url: `/api/triggers/${trigger.id}`,
    payload: { enabled: false },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json<{ enabled: boolean }>().enabled, false);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/triggers/${trigger.id}` })).status, 204);
});

test('a webhook trigger gets a token, and only that token fires it, without auth', async () => {
  // Its own prompt: firing the webhook queues a real run, and sharing the
  // suite's `promptId` would inflate the run counts later tests assert on.
  const ownPrompt = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: 'webhook-target', prompt: 'handle the webhook' },
  });
  const ownPromptId = ownPrompt.json<{ id: string }>().id;

  const created = await kube.request({
    method: 'POST',
    url: `/api/prompts/${ownPromptId}/triggers`,
    payload: { type: 'webhook' },
  });
  assert.equal(created.status, 201);
  const trigger = created.json<{ id: string; type: string; webhookToken: string }>();
  assert.equal(trigger.type, 'webhook');
  assert.ok(trigger.webhookToken && trigger.webhookToken.length > 10);

  // A wrong token behaves exactly like a missing trigger — nothing here says
  // which one it is.
  const bad = await kube.request({
    method: 'POST',
    url: `/api/webhooks/${trigger.id}/not-the-real-token`,
    payload: {},
  });
  assert.equal(bad.status, 404);

  const good = await kube.request({
    method: 'POST',
    url: `/api/webhooks/${trigger.id}/${trigger.webhookToken}`,
    payload: { source: 'asana', event: 'task.completed' },
  });
  assert.equal(good.status, 202);
  assert.equal(good.json<{ accepted: boolean }>().accepted, true);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/triggers/${trigger.id}` })).status, 204);
  assert.equal((await kube.request({ method: 'DELETE', url: `/api/prompts/${ownPromptId}` })).status, 204);
});

test('a retried webhook delivery does not stack a second run on a busy prompt', async () => {
  // Asana and most webhook senders document at-least-once delivery: a slow or
  // ambiguous response gets retried, and the retry must not queue a second run
  // on top of the one still working through the first delivery.
  const ownPrompt = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: 'webhook-busy-target', prompt: 'handle the webhook' },
  });
  const ownPromptId = ownPrompt.json<{ id: string }>().id;

  const created = await kube.request({
    method: 'POST',
    url: `/api/prompts/${ownPromptId}/triggers`,
    payload: { type: 'webhook' },
  });
  const trigger = created.json<{ id: string; webhookToken: string }>();

  // A run that never finishes on its own, so the prompt is reliably still busy
  // for the second delivery regardless of scheduling.
  process.env.FAKE_CLAUDE_MODE = 'burn';
  try {
    const first = await kube.request({
      method: 'POST',
      url: `/api/webhooks/${trigger.id}/${trigger.webhookToken}`,
      payload: {},
    });
    assert.equal(first.status, 202);
    const runId = first.json<{ runId: string }>().runId;

    const retried = await kube.request({
      method: 'POST',
      url: `/api/webhooks/${trigger.id}/${trigger.webhookToken}`,
      payload: {},
    });
    assert.equal(retried.status, 200);
    assert.equal(retried.json<{ accepted: boolean }>().accepted, false);

    await kube.request({ method: 'POST', url: `/api/runs/${runId}/cancel` });
  } finally {
    delete process.env.FAKE_CLAUDE_MODE;
  }

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/triggers/${trigger.id}` })).status, 204);
  assert.equal((await kube.request({ method: 'DELETE', url: `/api/prompts/${ownPromptId}` })).status, 204);
});

test('a trigger cannot be edited into a state where it would never fire', async () => {
  const created = await kube.request({
    method: 'POST',
    url: `/api/prompts/${promptId}/triggers`,
    payload: { type: 'interval', config: { intervalMinutes: 30 } },
  });
  const trigger = created.json<{ id: string }>();

  // Creating one of these is refused, so editing into the same shape has to be
  // too — otherwise the trigger sits in the list looking scheduled and does
  // nothing, with nothing to say why.
  for (const payload of [
    { type: 'interval', config: {} },
    { type: 'interval', config: { minIntervalMinutes: 5 } },
    { type: 'cron', cronExpression: '   ' },
  ]) {
    const response = await kube.request({
      method: 'PATCH',
      url: `/api/triggers/${trigger.id}`,
      payload,
    });
    assert.equal(response.status, 400, JSON.stringify(payload));
  }

  // A timezone the platform does not know throws on every scheduler tick and
  // fires never; it is refused where it is written instead.
  const badZone = await kube.request({
    method: 'PATCH',
    url: `/api/triggers/${trigger.id}`,
    payload: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' },
  });
  assert.equal(badZone.status, 400);

  const onCreate = await kube.request({
    method: 'POST',
    url: `/api/prompts/${promptId}/triggers`,
    payload: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Mars/Olympus' },
  });
  assert.equal(onCreate.status, 400);

  // The trigger kept the configuration it had, so a refused edit costs nothing.
  const stored = await kube.request({ method: 'GET', url: `/api/prompts/${promptId}/triggers` });
  const [current] = stored.json<Array<{ type: string; config: { intervalMinutes?: number } }>>();
  assert.equal(current?.type, 'interval');
  assert.equal(current?.config.intervalMinutes, 30);

  // And a real timezone still goes through.
  const good = await kube.request({
    method: 'PATCH',
    url: `/api/triggers/${trigger.id}`,
    payload: { type: 'cron', cronExpression: '0 9 * * *', timezone: 'Europe/Paris' },
  });
  assert.equal(good.status, 200);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/triggers/${trigger.id}` })).status, 204);
});

// --------------------------------------------------------------------------
// Runs
// --------------------------------------------------------------------------

test('running a prompt queues a run and the run shows up in the listing', async () => {
  const queued = await kube.request({ method: 'POST', url: `/api/prompts/${promptId}/run`, payload: {} });
  assert.equal(queued.status, 202);
  const run = queued.json<{ id: string; status: string; triggerType: string }>();
  assert.equal(run.triggerType, 'manual');
  assert.ok(['queued', 'running'].includes(run.status));

  const listed = await kube.request({ method: 'GET', url: `/api/runs?promptId=${promptId}` });
  assert.equal(listed.status, 200);
  const page = listed.json<{ items: Array<{ id: string }>; total: number }>();
  assert.equal(page.total, 1);
  assert.equal(page.items[0]?.id, run.id);

  const detail = await kube.request({ method: 'GET', url: `/api/runs/${run.id}` });
  assert.equal(detail.status, 200);

  // Resuming a run that has not stopped would put a second Claude on the same
  // session and spend the quota twice on the same work. Follow-up refuses it
  // for the same reason, and so must this. Keyed on the state as it is at this
  // instant rather than on how fast the stub CLI happened to be.
  const now = detail.json<{ status: string }>().status;
  const resumed = await kube.request({ method: 'POST', url: `/api/runs/${run.id}/resume` });
  if (now === 'queued' || now === 'running') {
    assert.equal(resumed.status, 409, 'a run in flight must not be resumable');
    assert.match(resumed.json<{ error: string }>().error, /has not finished/);
    const after = await kube.request({ method: 'GET', url: `/api/runs?promptId=${promptId}` });
    assert.equal(after.json<{ total: number }>().total, 1, 'nothing should have been queued behind it');
  }

  // Cancelling is idempotent from the caller's point of view: either it stopped
  // something, or the run had already finished and there is nothing to stop.
  const cancelled = await kube.request({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
  assert.ok([200, 409].includes(cancelled.status));
});

// --------------------------------------------------------------------------
// Goals
// --------------------------------------------------------------------------

let goalId = '';

test('a goal is created with its objectives and its own hidden prompt', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/goals',
    payload: {
      name: 'Healthy media namespace',
      description: 'Keep it green',
      objectives: ['Every pod ready', 'No pending PVC', '   '],
      cadenceMinutes: 60,
      startNow: false,
    },
  });
  assert.equal(created.status, 201);
  const goal = created.json<{
    id: string;
    objectives: Array<{ id: string; text: string }>;
    progress: { done: number; total: number };
    prompt: { id: string; kind: string; continueSession: boolean; appendSystemPrompt: string };
  }>();
  goalId = goal.id;

  // Blank lines are dropped rather than becoming an objective nobody can close.
  assert.equal(goal.objectives.length, 2);
  assert.deepEqual(
    goal.objectives.map((objective) => objective.id),
    ['o1', 'o2'],
  );
  assert.deepEqual(goal.progress, { done: 0, total: 2 });

  // The prompt behind it is what makes iterations one continuing session.
  assert.equal(goal.prompt.kind, 'goal');
  assert.equal(goal.prompt.continueSession, true);
  assert.match(goal.prompt.appendSystemPrompt, /PROGRESS:/);

  // And it stays out of the prompt list, which is about scheduled work.
  const prompts = await kube.request({ method: 'GET', url: '/api/prompts' });
  assert.equal(prompts.json<Array<{ id: string }>>().length, 1);
});

test('objectives can be added and ticked by hand, and the goal ends when they are all done', async () => {
  const added = await kube.request({
    method: 'PATCH',
    url: `/api/goals/${goalId}`,
    payload: { addObjectives: ['Alerts fire before users notice'] },
  });
  assert.equal(added.status, 200);
  const withThree = added.json<{ objectives: Array<{ id: string }>; progress: { total: number } }>();
  assert.equal(withThree.progress.total, 3);
  // Ids keep counting rather than being reused, so the log stays readable.
  assert.equal(withThree.objectives[2]?.id, 'o3');

  const allDone = withThree.objectives.map((objective) => ({
    ...objective,
    done: true,
    doneAt: new Date().toISOString(),
    note: 'Marked by hand',
  }));
  const ticked = await kube.request({
    method: 'PATCH',
    url: `/api/goals/${goalId}`,
    payload: { objectives: allDone },
  });
  assert.equal(ticked.status, 200);
  // Ticking the last one by hand ends the goal the way the loop would, rather
  // than leaving it to run one more pointless iteration.
  assert.equal(ticked.json<{ status: string }>().status, 'achieved');
});

test('an unrelated edit does not clobber an objective ticked while the request was in flight', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/goals',
    payload: { name: 'Race-prone goal', description: '', objectives: ['First thing'], startNow: false },
  });
  const goal = created.json<{ id: string; objectives: Array<{ id: string }> }>();

  // An iteration's review ticks an objective off directly in the store, the
  // way `reviewIteration` does — concurrently with, and finishing before, an
  // unrelated PATCH (renaming the goal) that read the goal a moment earlier.
  const goalStore = await import('../src/store/goals.js');
  goalStore.tickObjectives(goal.id, [goal.objectives[0]!.id], 'Done via the loop');

  const renamed = await kube.request({
    method: 'PATCH',
    url: `/api/goals/${goal.id}`,
    payload: { name: 'Renamed goal' },
  });
  assert.equal(renamed.status, 200);
  const body = renamed.json<{ name: string; objectives: Array<{ id: string; done: boolean }> }>();
  assert.equal(body.name, 'Renamed goal');
  // The rename must not have rewritten objectives from the stale snapshot it
  // read before the tick landed.
  assert.equal(body.objectives.find((o) => o.id === goal.objectives[0]!.id)?.done, true);

  await kube.request({ method: 'DELETE', url: `/api/goals/${goal.id}` });
});

test('a goal can be paused, resumed and iterated on demand', async () => {
  const resumed = await kube.request({ method: 'POST', url: `/api/goals/${goalId}/start` });
  assert.equal(resumed.json<{ status: string }>().status, 'active');

  const iterated = await kube.request({ method: 'POST', url: `/api/goals/${goalId}/iterate` });
  assert.equal(iterated.status, 202);
  const run = iterated.json<{ id: string; promptText: string; triggerType: string }>();
  assert.equal(run.triggerType, 'goal:manual');
  // The iteration is handed the goal, not the prompt's placeholder text.
  assert.match(run.promptText, /Healthy media namespace/);
  assert.match(run.promptText, /Every pod ready/);

  // A second one cannot stack on top of the first.
  const again = await kube.request({ method: 'POST', url: `/api/goals/${goalId}/iterate` });
  assert.equal(again.status, 409);

  const paused = await kube.request({ method: 'POST', url: `/api/goals/${goalId}/pause` });
  assert.equal(paused.json<{ status: string }>().status, 'paused');

  const detail = await kube.request({ method: 'GET', url: `/api/goals/${goalId}` });
  assert.equal(detail.status, 200);
  const view = detail.json<{ runs: unknown[]; iterations: unknown[] }>();
  assert.equal(view.runs.length, 1);
  assert.deepEqual(view.iterations, []);
});

test('a goal that is not running refuses to be iterated by hand', async () => {
  // Only the loop reads a report, and the loop leaves a paused goal alone — so
  // an iteration started here would spend tokens and be thrown away.
  const refused = await kube.request({ method: 'POST', url: `/api/goals/${goalId}/iterate` });
  assert.equal(refused.status, 409);
  assert.match(refused.json<{ error: string }>().error, /Resume the goal/);
});

test('deleting a goal takes its prompt and its runs with it', async () => {
  const before = await kube.request({ method: 'GET', url: '/api/runs?limit=100' });
  const runsBefore = before.json<{ total: number }>().total;

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/goals/${goalId}` })).status, 204);
  assert.equal((await kube.request({ method: 'GET', url: `/api/goals/${goalId}` })).status, 404);
  assert.deepEqual((await kube.request({ method: 'GET', url: '/api/goals' })).json(), []);

  const after = await kube.request({ method: 'GET', url: '/api/runs?limit=100' });
  assert.ok(after.json<{ total: number }>().total < runsBefore);
});

// --------------------------------------------------------------------------
// Chats
// --------------------------------------------------------------------------

test('a chat starts, carries a title and refuses a second message while busy', async () => {
  const started = await kube.request({
    method: 'POST',
    url: '/api/chats',
    payload: { message: 'Is the media namespace healthy?\nCheck the pods.' },
  });
  assert.equal(started.status, 201);
  const chat = started.json<{ id: string; title: string; kind: string; permissionMode: string }>();
  assert.equal(chat.kind, 'chat');
  // The title is the first line of the opening message, not the whole thing.
  assert.equal(chat.title, 'Is the media namespace healthy?');
  // A person is watching, so a chat can act without asking.
  assert.equal(chat.permissionMode, 'bypassPermissions');

  const busy = await kube.request({
    method: 'POST',
    url: `/api/chats/${chat.id}/messages`,
    payload: { message: 'And the PVCs?' },
  });
  assert.equal(busy.status, 409);

  const listed = await kube.request({ method: 'GET', url: '/api/chats' });
  assert.equal(listed.json<unknown[]>().length, 1);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/chats/${chat.id}` })).status, 204);
});

// --------------------------------------------------------------------------
// MCP connections
// --------------------------------------------------------------------------

test('an MCP connection is stored and rendered into a .mcp.json document', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/mcp-servers',
    payload: { name: 'k8s', config: JSON.stringify({ type: 'sse', url: 'https://mcp.example/sse' }) },
  });
  assert.equal(created.status, 201);
  const server = created.json<{ id: string }>();

  const preview = await kube.request({
    method: 'POST',
    url: '/api/mcp-servers/preview',
    payload: { serverIds: [server.id], inlineConfig: null },
  });
  assert.equal(preview.status, 200);
  const document = preview.json<{ document: string }>().document;
  assert.match(document, /mcpServers/);
  assert.match(document, /mcp\.example/);

  // Config that is not JSON cannot reach the CLI, so it is refused here.
  const bad = await kube.request({
    method: 'POST',
    url: '/api/mcp-servers',
    payload: { name: 'broken', config: 'not json' },
  });
  assert.equal(bad.status, 400);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/mcp-servers/${server.id}` })).status, 204);
});

test('renaming an MCP connection onto an existing name is refused cleanly, not a 500', async () => {
  const first = await kube.request({
    method: 'POST',
    url: '/api/mcp-servers',
    payload: { name: 'taken', config: JSON.stringify({ type: 'sse', url: 'https://one.example/sse' }) },
  });
  assert.equal(first.status, 201);

  const second = await kube.request({
    method: 'POST',
    url: '/api/mcp-servers',
    payload: { name: 'free', config: JSON.stringify({ type: 'sse', url: 'https://two.example/sse' }) },
  });
  assert.equal(second.status, 201);
  const secondId = second.json<{ id: string }>().id;

  const renamed = await kube.request({
    method: 'PATCH',
    url: `/api/mcp-servers/${secondId}`,
    payload: { name: 'taken' },
  });
  assert.equal(renamed.status, 409);
  assert.match(renamed.json<{ error: string }>().error, /already exists/);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/mcp-servers/${first.json<{ id: string }>().id}` })).status, 204);
  assert.equal((await kube.request({ method: 'DELETE', url: `/api/mcp-servers/${secondId}` })).status, 204);
});

// --------------------------------------------------------------------------
// Agents
// --------------------------------------------------------------------------

test('a shared agent is stored, attached to a prompt, and rendered into --agents', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/agents',
    payload: {
      name: 'reviewer',
      description: 'Reviews a diff',
      config: JSON.stringify({ description: 'Reviews a diff', prompt: 'You are a reviewer.' }),
    },
  });
  assert.equal(created.status, 201);
  const agent = created.json<{ id: string; name: string }>();

  // A second agent with the same name collides with the DB's UNIQUE index.
  const dupe = await kube.request({
    method: 'POST',
    url: '/api/agents',
    payload: { name: 'reviewer', description: '', config: JSON.stringify({ prompt: 'x' }) },
  });
  assert.equal(dupe.status, 409);

  const preview = await kube.request({
    method: 'POST',
    url: '/api/agents/preview',
    payload: { agentIds: [agent.id], inlineConfig: null },
  });
  assert.equal(preview.status, 200);
  const document = JSON.parse(preview.json<{ document: string }>().document);
  assert.equal(document.reviewer.prompt, 'You are a reviewer.');

  // Attached to a prompt the same way a shared MCP connection is.
  const attached = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${promptId}`,
    payload: { agentIds: [agent.id] },
  });
  assert.equal(attached.status, 200);
  assert.deepEqual(attached.json<{ agentIds: string[] }>().agentIds, [agent.id]);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/agents/${agent.id}` })).status, 204);

  // Deleting the agent drops it from the prompt that held it, rather than
  // leaving a dangling reference.
  const reloaded = await kube.request({ method: 'GET', url: `/api/prompts/${promptId}` });
  assert.deepEqual(reloaded.json<{ agentIds: string[] }>().agentIds, []);
});

// --------------------------------------------------------------------------
// Settings and status
// --------------------------------------------------------------------------

test('settings round-trip and refuse values that would be nonsense', async () => {
  const patched = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { sessionTokenBudget: 500_000, budgetBasis: 'total', defaultMaxTurns: 12 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json<{ sessionTokenBudget: number }>().sessionTokenBudget, 500_000);

  const read = await kube.request({ method: 'GET', url: '/api/settings' });
  assert.equal(read.json<{ budgetBasis: string }>().budgetBasis, 'total');

  const bad = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { budgetBasis: 'vibes' },
  });
  assert.equal(bad.status, 400);

  // The shipped defaults stay available so the UI can offer "restore".
  const defaults = await kube.request({ method: 'GET', url: '/api/settings/defaults' });
  assert.equal(defaults.json<{ budgetBasis: string }>().budgetBasis, 'weighted');

  await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { sessionTokenBudget: 0, budgetBasis: 'weighted' },
  });
});

test('the notification webhook url is validated, and empty disables it', async () => {
  const bad = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { notifyWebhookUrl: 'not a url' },
  });
  assert.equal(bad.status, 400);

  const set = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { notifyWebhookUrl: 'https://hooks.example/incoming', notifyOnFailure: true, notifyOnSuccess: true },
  });
  assert.equal(set.status, 200);
  assert.equal(set.json<{ notifyWebhookUrl: string }>().notifyWebhookUrl, 'https://hooks.example/incoming');

  // Empty string is the deliberate "off" value, not a validation failure.
  const cleared = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { notifyWebhookUrl: '' },
  });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json<{ notifyWebhookUrl: string }>().notifyWebhookUrl, '');
});

test('status reports the build, the quota and what the runs can reach', async () => {
  const status = await kube.request({ method: 'GET', url: '/api/status' });
  assert.equal(status.status, 200);
  const body = status.json<{ version: string; quota: { canRun: boolean }; maxConcurrentRuns: number }>();
  assert.ok(body.version);
  assert.equal(body.maxConcurrentRuns, 1);
  assert.equal(typeof body.quota.canRun, 'boolean');

  const dashboard = await kube.request({ method: 'GET', url: '/api/dashboard' });
  assert.equal(dashboard.status, 200);
  assert.ok(Array.isArray(dashboard.json<{ recentRuns: unknown[] }>().recentRuns));
});

// --------------------------------------------------------------------------
// Repositories
// --------------------------------------------------------------------------

test('a prompt can name a repository, and only a real remote', async () => {
  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: {
      name: 'with-repo',
      prompt: 'fix the failing test and open a pull request',
      repoUrl: 'https://github.com/owner/repo.git',
      repoRef: 'main',
    },
  });
  assert.equal(created.status, 201);
  const prompt = created.json<{ id: string; repoUrl: string; repoRef: string }>();
  assert.equal(prompt.repoUrl, 'https://github.com/owner/repo.git');
  assert.equal(prompt.repoRef, 'main');

  // A path on the pod's disk is not a remote, and handing one to `git clone`
  // is either a mistake or an attempt to read something else on the volume.
  for (const repoUrl of ['/data/kubeclaude.db', 'file:///etc', 'ext::sh -c whoami']) {
    const refused = await kube.request({
      method: 'POST',
      url: '/api/prompts',
      payload: { name: `bad-${repoUrl.length}`, prompt: 'x', repoUrl },
    });
    assert.equal(refused.status, 400, `${repoUrl} should be refused`);
  }

  // Nor is a ref that could be read as a flag.
  const badRef = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${prompt.id}`,
    payload: { repoRef: '--upload-pack=touch /tmp/pwned' },
  });
  assert.equal(badRef.status, 400);

  // ssh remotes are fine — a deployment with a deploy key is a normal setup.
  const ssh = await kube.request({
    method: 'PATCH',
    url: `/api/prompts/${prompt.id}`,
    payload: { repoUrl: 'git@github.com:owner/repo.git' },
  });
  assert.equal(ssh.status, 200);

  assert.equal((await kube.request({ method: 'DELETE', url: `/api/prompts/${prompt.id}` })).status, 204);
});

test('the git identity is a setting, and capabilities says whether a token is there', async () => {
  const updated = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitUserName: 'KubeClaude Bot', gitUserEmail: 'bot@example.com' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json<{ gitUserName: string }>().gitUserName, 'KubeClaude Bot');

  // An address git will accept, or nothing.
  const refused = await kube.request({
    method: 'PATCH',
    url: '/api/settings',
    payload: { gitUserEmail: 'not-an-address' },
  });
  assert.equal(refused.status, 400);

  const capabilities = await kube.request({ method: 'GET', url: '/api/capabilities' });
  const git = capabilities.json<{ git: { userEmail: string; githubToken: boolean } }>().git;
  assert.equal(git.userEmail, 'bot@example.com');
  // Reported as present or absent, never echoed.
  assert.equal(typeof git.githubToken, 'boolean');
  assert.ok(!capabilities.body.includes('ghp_'), 'a token must never be returned');
});

// --------------------------------------------------------------------------
// Completion in the composer
// --------------------------------------------------------------------------

test('a prompt can list the files in its workspace, and only those', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const created = await kube.request({
    method: 'POST',
    url: '/api/prompts',
    payload: { name: 'with-files', prompt: 'work in here' },
  });
  const promptId = created.json<{ id: string }>().id;

  // The managed workspace this prompt would run in, with a shape worth
  // completing against and two directories nobody wants suggested.
  const root = path.join(kube.dir, 'workspaces', promptId);
  fs.mkdirSync(path.join(root, 'server/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/left-pad'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'server/src/db.ts'), 'export const db = 1;');
  fs.writeFileSync(path.join(root, 'README.md'), '# hello');
  fs.writeFileSync(path.join(root, 'node_modules/left-pad/index.js'), '');
  fs.writeFileSync(path.join(root, '.git/HEAD'), 'ref: refs/heads/main');

  const all = await kube.request({ method: 'GET', url: `/api/prompts/${promptId}/files` });
  assert.equal(all.status, 200);
  const listing = all.json<{ root: string; items: Array<{ path: string; directory: boolean }> }>();
  assert.equal(listing.root, root);

  const paths = listing.items.map((item) => item.path);
  assert.ok(paths.includes('README.md'));
  assert.ok(paths.includes('server/'));
  // Suggesting a dependency tree or the object store would drown everything
  // worth picking.
  assert.ok(!paths.some((entry) => entry.startsWith('node_modules')), paths.join(', '));
  assert.ok(!paths.some((entry) => entry.startsWith('.git')), paths.join(', '));

  const filtered = await kube.request({ method: 'GET', url: `/api/prompts/${promptId}/files?q=db` });
  assert.deepEqual(
    filtered.json<{ items: Array<{ path: string }> }>().items.map((item) => item.path),
    ['server/src/db.ts'],
  );

  // The query only ever filters what the walk already found; it cannot climb
  // out of the workspace.
  const escape = await kube.request({
    method: 'GET',
    url: `/api/prompts/${promptId}/files?q=${encodeURIComponent('../../kubeclaude.db')}`,
  });
  assert.deepEqual(escape.json<{ items: unknown[] }>().items, []);

  assert.equal((await kube.request({ method: 'GET', url: '/api/prompts/nope/files' })).status, 404);
});

// --------------------------------------------------------------------------
// The error feed
// --------------------------------------------------------------------------

test('a browser fault is recorded, counted rather than repeated, and cannot lie about where it came from', async () => {
  const report = {
    message: 'Cannot read properties of undefined (reading map)',
    detail: 'TypeError: ...\n    at Runs (/assets/index.js:1:1)',
    context: '/runs',
    // Not part of the schema; a client must not be able to file a fault as the
    // server's, because that is the one place you look when something is wrong.
    source: 'server',
  };

  const first = await kube.request({ method: 'POST', url: '/api/errors', payload: report });
  assert.equal(first.status, 201);
  assert.equal(first.json<{ source: string; count: number }>().source, 'browser');

  const second = await kube.request({ method: 'POST', url: '/api/errors', payload: report });
  assert.equal(second.json<{ count: number }>().count, 2);

  const listed = await kube.request({ method: 'GET', url: '/api/errors' });
  const body = listed.json<{ items: Array<{ id: string; message: string; count: number }>; total: number }>();
  assert.equal(body.total, 1, 'the same fault twice is one entry');
  assert.equal(body.items[0]?.count, 2);

  // And the sidebar can see it without asking a second endpoint.
  const status = await kube.request({ method: 'GET', url: '/api/status' });
  assert.equal(status.json<{ errorCount: number }>().errorCount, 1);

  const id = body.items[0].id;
  assert.equal((await kube.request({ method: 'DELETE', url: `/api/errors/${id}` })).status, 204);
  assert.equal((await kube.request({ method: 'DELETE', url: `/api/errors/${id}` })).status, 404);
  assert.equal((await kube.request({ method: 'GET', url: '/api/errors' })).json<{ total: number }>().total, 0);
});

test('an error report without a message is refused', async () => {
  const response = await kube.request({ method: 'POST', url: '/api/errors', payload: { message: '' } });
  assert.equal(response.status, 400);
});

test('the backups endpoint lists what is on disk', async () => {
  const response = await kube.request({ method: 'GET', url: '/api/backups' });
  assert.equal(response.status, 200);
  // A fresh instance has never migrated over an existing database, so there is
  // nothing to show — the shape is what matters here.
  assert.ok(Array.isArray(response.json<{ items: unknown[] }>().items));
});

// --------------------------------------------------------------------------
// Auth administration
// --------------------------------------------------------------------------

test('the login method can be changed, and a session survives it', async () => {
  const patched = await kube.request({
    method: 'PATCH',
    url: '/api/auth/config',
    payload: { requirement: 'local_bypass', sessionDays: 7 },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json<{ requirement: string }>().requirement, 'local_bypass');

  assert.equal((await kube.request({ method: 'GET', url: '/api/prompts' })).status, 200);

  await kube.request({ method: 'PATCH', url: '/api/auth/config', payload: { requirement: 'always' } });
});

test('changing the password needs the old one and re-issues the session', async () => {
  const wrong = await kube.request({
    method: 'POST',
    url: '/api/auth/password',
    payload: { currentPassword: 'not-it', newPassword: 'another-good-one' },
  });
  assert.equal(wrong.status, 403);

  const changed = await kube.request({
    method: 'POST',
    url: '/api/auth/password',
    payload: { currentPassword: 'a-good-password', newPassword: 'another-good-one' },
  });
  assert.equal(changed.status, 200);
  // The old sessions are gone, but this caller was handed a fresh one rather
  // than being thrown out of the page they are standing on.
  assert.equal((await kube.request({ method: 'GET', url: '/api/prompts' })).status, 200);

  const relogin = await kube.request({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'tester', password: 'another-good-one' },
  });
  assert.equal(relogin.status, 200);
});

test('rotating the API key invalidates the previous one', async () => {
  const rotated = await kube.request({ method: 'POST', url: '/api/auth/api-key' });
  assert.equal(rotated.status, 200);
  const fresh = rotated.json<{ apiKey: string }>().apiKey;
  assert.notEqual(fresh, apiKey);

  assert.equal((await kube.as(fresh)({ method: 'GET', url: '/api/prompts' })).status, 200);
  assert.equal((await kube.as(apiKey)({ method: 'GET', url: '/api/prompts' })).status, 401);
  apiKey = fresh;
});

test('signing out closes the door behind you', async () => {
  assert.equal((await kube.request({ method: 'POST', url: '/api/auth/logout' })).status, 200);
  assert.equal((await kube.request({ method: 'GET', url: '/api/prompts' })).status, 401);

  // The API key is unaffected: automation does not sign out.
  assert.equal((await kube.as(apiKey)({ method: 'GET', url: '/api/prompts' })).status, 200);
});
