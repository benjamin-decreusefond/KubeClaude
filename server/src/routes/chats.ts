import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { cancelRun, enqueueRun } from '../queue.js';
import * as promptStore from '../store/prompts.js';
import * as runStore from '../store/runs.js';
import { permissionModeSchema } from './schemas.js';
import type { Prompt, Run } from '../types.js';

const idParams = z.object({ id: z.string().min(1) });

/**
 * A chat starts with sensible-for-conversation defaults rather than the
 * conservative ones a scheduled prompt gets. The person is right there watching,
 * which is the safest context for an agent that can act — more so than an
 * unattended cron run — so tools are not gated behind approvals nobody can give.
 */
const startSchema = z.object({
  message: z.string().min(1).max(100_000),
  model: z.string().max(120).nullable().default(null),
  permissionMode: permissionModeSchema.default('bypassPermissions'),
  workingDir: z.string().max(1024).nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  disallowedTools: z.array(z.string()).default([]),
  mcpServerIds: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  timeoutSeconds: z.number().int().min(30).max(86_400).default(3600),
  /** Copy configuration from an existing prompt, then talk to it. */
  fromPromptId: z.string().optional(),
});

const messageSchema = z.object({ message: z.string().min(1).max(100_000) });

/** First line of the opening message, trimmed to something list-sized. */
function deriveTitle(message: string): string {
  const line = message.trim().split('\n').find((candidate) => candidate.trim().length > 0) ?? 'New chat';
  const clean = line.replace(/^[#>\-*\s]+/, '').trim();
  return clean.length > 70 ? `${clean.slice(0, 67)}…` : clean || 'New chat';
}

function latestRun(promptId: string): Run | null {
  return runStore.listRuns({ promptId, limit: 1 })[0] ?? null;
}

function chatView(chat: Prompt) {
  const runs = runStore.listRuns({ promptId: chat.id, limit: 200 }).reverse();
  const last = runs[runs.length - 1];
  return {
    ...chat,
    runs,
    /** True while a turn is in flight, so the UI can hold the composer. */
    busy: last ? last.status === 'queued' || last.status === 'running' : false,
  };
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/chats', async () => {
    return promptStore.listChats().map((chat) => {
      const last = latestRun(chat.id);
      return {
        id: chat.id,
        title: chat.title ?? chat.name,
        model: chat.model,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        lastRun: last,
        messageCount: runStore.countRuns({ promptId: chat.id }),
      };
    });
  });

  app.post('/api/chats', async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid message', details: parsed.error.flatten() });
    }
    const input = parsed.data;

    // Starting from an existing prompt reuses its access and model, so you can
    // talk to a scheduled task interactively before letting it run on its own.
    const source = input.fromPromptId ? promptStore.getPrompt(input.fromPromptId) : null;
    if (input.fromPromptId && !source) {
      return reply.code(404).send({ error: 'Prompt not found' });
    }

    const chat = promptStore.createPrompt({
      kind: 'chat',
      // `name` is unique and never shown; `title` is what the UI displays.
      name: `chat-${randomUUID()}`,
      title: deriveTitle(input.message),
      description: source ? `Started from ${source.name}` : '',
      prompt: input.message,
      enabled: true,
      model: input.model ?? source?.model ?? null,
      workingDir: input.workingDir ?? source?.workingDir ?? null,
      permissionMode: input.permissionMode,
      allowedTools: input.allowedTools.length > 0 ? input.allowedTools : (source?.allowedTools ?? []),
      disallowedTools:
        input.disallowedTools.length > 0 ? input.disallowedTools : (source?.disallowedTools ?? []),
      appendSystemPrompt: source?.appendSystemPrompt ?? null,
      maxTurns: null,
      timeoutSeconds: input.timeoutSeconds,
      env: { ...(source?.env ?? {}), ...input.env },
      mcpConfig: source?.mcpConfig ?? null,
      mcpServerIds: input.mcpServerIds.length > 0 ? input.mcpServerIds : (source?.mcpServerIds ?? []),
      settingsJson: source?.settingsJson ?? null,
      claudeMd: source?.claudeMd ?? null,
      // Each message already resumes the previous session explicitly.
      continueSession: false,
      // A person is present, so parking a turn for hours is not what they want.
      autoResume: false,
      maxAutoResumes: 0,
      resumePrompt: null,
      completionCheck: 'never',
      completionMarker: null,
      judgeModel: null,
    });

    const run = enqueueRun({ promptId: chat.id, triggerType: 'chat', promptText: input.message });
    if (!run) return reply.code(409).send({ error: 'Could not start the chat' });
    return reply.code(201).send(chatView(promptStore.getPrompt(chat.id)!));
  });

  app.get('/api/chats/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });
    return chatView(chat);
  });

  app.post('/api/chats/:id/messages', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Invalid message', details: parsed.error.flatten() });
    }
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });

    const previous = latestRun(chat.id);
    if (previous && (previous.status === 'queued' || previous.status === 'running')) {
      // The CLI cannot take input mid-turn; the UI holds the message instead.
      return reply.code(409).send({ error: 'Claude is still working on the previous message' });
    }

    const run = enqueueRun({
      promptId: chat.id,
      triggerType: 'chat',
      promptText: parsed.data.message,
      followUpText: parsed.data.message,
      resumeOfRunId: previous?.id ?? null,
      // Without a session to resume this would start over with no context.
      sessionId: previous?.sessionId ?? null,
    });
    if (!run) return reply.code(409).send({ error: 'Could not queue the message' });

    promptStore.updatePrompt(chat.id, {});
    return reply.code(202).send(run);
  });

  app.post('/api/chats/:id/stop', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });
    const run = latestRun(chat.id);
    if (!run || !cancelRun(run.id)) {
      return reply.code(409).send({ error: 'Nothing is running' });
    }
    return runStore.getRun(run.id);
  });

  app.patch('/api/chats/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z.object({ title: z.string().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid title' });
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });
    return promptStore.updatePrompt(id, { title: parsed.data.title });
  });

  app.delete('/api/chats/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });
    promptStore.deletePrompt(id);
    return reply.code(204).send();
  });

  /** Turn a conversation into a scheduled prompt, keeping its configuration. */
  app.post('/api/chats/:id/promote', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const parsed = z
      .object({ name: z.string().min(1).max(120), prompt: z.string().min(1) })
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'A name and a prompt are required' });
    const chat = promptStore.getPrompt(id);
    if (!chat || chat.kind !== 'chat') return reply.code(404).send({ error: 'Chat not found' });

    try {
      const created = promptStore.createPrompt({
        ...chat,
        kind: 'scheduled',
        title: null,
        name: parsed.data.name,
        prompt: parsed.data.prompt,
        description: `Promoted from a chat`,
        // Scheduled runs are unattended, so the resume policy matters again.
        autoResume: true,
        maxAutoResumes: 5,
        completionCheck: 'marker',
      });
      return reply.code(201).send(created);
    } catch (error) {
      if (String(error).includes('UNIQUE')) {
        return reply.code(409).send({ error: 'A prompt with that name already exists' });
      }
      throw error;
    }
  });
}
