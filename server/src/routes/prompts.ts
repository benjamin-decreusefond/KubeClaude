import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { workspaceFor } from '../claude/runner.js';
import { suggestFiles } from '../claude/workspace-files.js';
import { cancelRunsForPrompt, enqueueRun } from '../queue.js';
import * as promptStore from '../store/prompts.js';
import * as triggerStore from '../store/triggers.js';
import { listRuns } from '../store/runs.js';
import { getSettings } from '../store/settings.js';
import {
  promptCreateSchema,
  promptUpdateSchema,
  runRequestSchema,
  triggerCreateSchema,
} from './schemas.js';

const idParams = z.object({ id: z.string().min(1) });

const fileQuery = z.object({
  q: z.string().max(200).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** "Name (copy)", then "Name (copy 2)", "Name (copy 3)"… past the first collision. */
function uniquePromptCopyName(name: string): string {
  const base = `${name} (copy)`.slice(0, 120);
  if (!promptStore.promptNameExists(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} (copy ${n})`.slice(0, 120);
    if (!promptStore.promptNameExists(candidate)) return candidate;
  }
}

export async function promptRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/prompts', async () => {
    const prompts = promptStore.listPrompts();
    return prompts.map((prompt) => ({
      ...prompt,
      triggers: triggerStore.listTriggers(prompt.id),
      lastRun: listRuns({ promptId: prompt.id, limit: 1 })[0] ?? null,
    }));
  });

  app.post('/api/prompts', async (request, reply) => {
    const parsed = promptCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid prompt', details: parsed.error.flatten() });
    }
    try {
      const prompt = promptStore.createPrompt({ ...parsed.data, kind: 'scheduled', title: null });
      return reply.code(201).send(prompt);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A prompt with that name already exists' });
      }
      throw error;
    }
  });

  app.get('/api/prompts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const prompt = promptStore.getPrompt(id);
    if (!prompt) return reply.code(404).send({ error: 'Prompt not found' });
    return {
      ...prompt,
      triggers: triggerStore.listTriggers(prompt.id),
      recentRuns: listRuns({ promptId: prompt.id, limit: 20 }),
    };
  });

  app.patch('/api/prompts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = promptUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid prompt', details: parsed.error.flatten() });
    }
    if (!promptStore.getPrompt(id)) return reply.code(404).send({ error: 'Prompt not found' });
    try {
      return promptStore.updatePrompt(id, parsed.data);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A prompt with that name already exists' });
      }
      throw error;
    }
  });

  /**
   * A starting point for "like this one, but…" — the full configuration,
   * none of the history. Triggers are deliberately not copied: two prompts
   * both wired to the same schedule or the same webhook would fire twice for
   * one event, which is never what duplicating a prompt is for.
   */
  app.post('/api/prompts/:id/duplicate', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const source = promptStore.getPrompt(id);
    if (!source || source.kind !== 'scheduled') {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, lastSessionId: _lastSessionId, ...rest } = source;
    const copy = promptStore.createPrompt({ ...rest, name: uniquePromptCopyName(source.name) });
    return reply.code(201).send(copy);
  });

  app.delete('/api/prompts/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!promptStore.getPrompt(id)) return reply.code(404).send({ error: 'Prompt not found' });
    // Stop the work before removing what it belongs to: deleting the rows under
    // a live Claude leaves it writing output nobody can read.
    cancelRunsForPrompt(id);
    promptStore.deletePrompt(id);
    return reply.code(204).send();
  });

  /**
   * Files under this prompt's working directory, for the composer's `@`
   * completion. Names only — no contents — and the walk is rooted in the
   * workspace, so `q` can only ever filter what is already there.
   */
  app.get('/api/prompts/:id/files', async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid id' });

    const prompt = promptStore.getPrompt(params.data.id);
    if (!prompt) return reply.code(404).send({ error: 'Not found' });

    const query = fileQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'Invalid query' });

    const root = workspaceFor(prompt);
    return { root, items: suggestFiles(root, query.data.q, query.data.limit) };
  });

  app.post('/api/prompts/:id/run', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = runRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid request', details: parsed.error.flatten() });
    }
    const prompt = promptStore.getPrompt(id);
    if (!prompt) return reply.code(404).send({ error: 'Prompt not found' });

    const run = enqueueRun({
      promptId: id,
      triggerId: null,
      triggerType: 'manual',
      promptText: parsed.data.promptText,
    });
    if (!run) return reply.code(409).send({ error: 'Could not queue the run' });
    return reply.code(202).send(run);
  });

  app.get('/api/prompts/:id/triggers', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!promptStore.getPrompt(id)) return reply.code(404).send({ error: 'Prompt not found' });
    return triggerStore.listTriggers(id);
  });

  app.post('/api/prompts/:id/triggers', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!promptStore.getPrompt(id)) return reply.code(404).send({ error: 'Prompt not found' });
    const parsed = triggerCreateSchema.safeParse({
      timezone: getSettings().timezone,
      ...(request.body as object),
    });
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid trigger', details: parsed.error.flatten() });
    }
    const trigger = triggerStore.createTrigger({ promptId: id, ...parsed.data });
    return reply.code(201).send(trigger);
  });
}
