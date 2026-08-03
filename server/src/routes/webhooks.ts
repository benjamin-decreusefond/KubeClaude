import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { safeEqual } from '../auth/secrets.js';
import { enqueueRun } from '../queue.js';
import { getPrompt } from '../store/prompts.js';
import { getTrigger, markFired } from '../store/triggers.js';

const params = z.object({ triggerId: z.string().min(1), token: z.string().min(1) });

/**
 * A trigger fired by something outside KubeClaude instead of by a clock: an
 * inbound POST from Asana, Jira, GitHub, or anything else that can call a URL.
 * There is no session or API key to check — the caller is a third-party
 * service — so the unguessable token embedded in the URL itself is the only
 * credential, compared in constant time so a network observer cannot learn it
 * byte by byte from response timing.
 *
 * Registered as its own plugin, and listed in `isPublicPath`, because it must
 * answer before the normal auth guard runs.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/webhooks/:triggerId/:token', async (request, reply) => {
    const parsedParams = params.safeParse(request.params);
    if (!parsedParams.success) return reply.code(404).send({ error: 'Not found' });
    const { triggerId, token } = parsedParams.data;

    const trigger = getTrigger(triggerId);
    // A missing trigger, a wrong secret, and a trigger of the wrong type all
    // answer identically: there is nothing here for whoever is asking to learn
    // from the difference.
    if (!trigger || trigger.type !== 'webhook' || !trigger.webhookToken || !safeEqual(token, trigger.webhookToken)) {
      return reply.code(404).send({ error: 'Not found' });
    }

    // Asana's webhook registration sends one handshake request — an empty body
    // carrying X-Hook-Secret — and expects that exact value echoed back in the
    // response header within 10 seconds. Nothing to enqueue: this call only
    // proves the URL is reachable.
    const handshake = request.headers['x-hook-secret'];
    if (typeof handshake === 'string' && handshake) {
      reply.header('X-Hook-Secret', handshake);
      return reply.code(200).send();
    }

    if (!trigger.enabled) {
      return reply.code(200).send({ accepted: false, reason: 'Trigger is paused' });
    }

    const prompt = getPrompt(trigger.promptId);
    if (!prompt || !prompt.enabled) {
      return reply.code(200).send({ accepted: false, reason: 'Prompt is missing or disabled' });
    }

    const minMinutes = trigger.config.minIntervalMinutes ?? 0;
    if (minMinutes > 0 && trigger.lastFiredAt) {
      const elapsedMs = Date.now() - new Date(trigger.lastFiredAt).getTime();
      if (elapsedMs < minMinutes * 60_000) {
        return reply.code(200).send({ accepted: false, reason: 'Rate limited by the trigger’s minimum interval' });
      }
    }

    const promptText = appendPayload(prompt.prompt, request.body);
    const run = enqueueRun({ promptId: prompt.id, triggerId: trigger.id, triggerType: 'webhook', promptText });
    if (!run) return reply.code(200).send({ accepted: false, reason: 'Could not queue the run' });

    markFired(trigger.id, new Date().toISOString(), null);
    return reply.code(202).send({ accepted: true, runId: run.id });
  });
}

/** Give the model the raw event, not just the fact that one arrived. */
function appendPayload(promptText: string, body: unknown): string {
  if (body === undefined || body === null || (typeof body === 'object' && Object.keys(body).length === 0)) {
    return promptText;
  }
  const payload = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  return `${promptText}\n\n---\nWebhook payload received:\n\`\`\`json\n${payload}\n\`\`\``;
}
