import { config } from './config.js';
import { bus } from './events.js';
import { logger } from './logger.js';
import { runClaude } from './claude/runner.js';
import { detectRateLimit } from './claude/rate-limit.js';
import { assessCompletion, markerFor, markerInstruction } from './claude/completion.js';
import * as runs from './store/runs.js';
import { getPrompt, updatePrompt } from './store/prompts.js';
import { getSettings } from './store/settings.js';
import { addUsage, getQuotaState, openWindows } from './store/usage.js';
import type { Run, RunStatus } from './types.js';

const inFlight = new Map<string, AbortController>();
let draining = false;
let shuttingDown = false;

export interface EnqueueOptions {
  promptId: string;
  triggerId?: string | null;
  triggerType: string;
  /** Override the stored prompt text for this run only. */
  promptText?: string;
  resumeOfRunId?: string | null;
  resumeAttempt?: number;
  sessionId?: string | null;
  /** Human follow-up text, recorded on the run for the conversation view. */
  followUpText?: string | null;
  /** Refuse to queue when the prompt already has a queued or running run. */
  skipIfBusy?: boolean;
}

export function enqueueRun(options: EnqueueOptions): Run | null {
  const prompt = getPrompt(options.promptId);
  if (!prompt) return null;
  if (options.skipIfBusy && runs.hasActiveRunForPrompt(prompt.id)) {
    logger.debug({ prompt: prompt.name }, 'skipping enqueue, prompt already has an active run');
    return null;
  }

  const run = runs.createRun({
    promptId: prompt.id,
    promptName: prompt.name,
    triggerId: options.triggerId ?? null,
    triggerType: options.triggerType,
    promptText: options.promptText ?? prompt.prompt,
    resumeOfRunId: options.resumeOfRunId ?? null,
    resumeAttempt: options.resumeAttempt ?? 0,
    sessionId: options.sessionId ?? (prompt.continueSession ? prompt.lastSessionId : null),
    followUpText: options.followUpText ?? null,
  });

  bus.emit('run:created', run);
  queueMicrotask(() => void drain());
  return run;
}

export function cancelRun(runId: string): boolean {
  const controller = inFlight.get(runId);
  if (controller) {
    controller.abort();
    return true;
  }
  const run = runs.getRun(runId);
  if (run?.status === 'queued') {
    finish(runId, 'cancelled', { error: 'Cancelled before it started' });
    return true;
  }
  if (run?.status === 'rate_limited' && run.autoResumePending) {
    runs.updateRun(runId, { autoResumePending: false });
    emitUpdate(runId);
    return true;
  }
  return false;
}

export function activeRunCount(): number {
  return inFlight.size;
}

/** Start as many queued runs as the concurrency limit and quota guard allow. */
export async function drain(): Promise<void> {
  if (draining || shuttingDown) return;
  draining = true;
  try {
    while (inFlight.size < config.maxConcurrentRuns) {
      const next = runs.listQueuedRuns().find((run) => !inFlight.has(run.id));
      if (!next) break;

      const quota = getQuotaState();
      if (!quota.canRun) {
        // Park it rather than fail it: the auto-resume sweep picks it back up.
        parkForQuota(next, quota.reason ?? 'Token budget exhausted', quota.session.resetsAt);
        continue;
      }

      void execute(next);
    }
  } finally {
    draining = false;
  }
}

function parkForQuota(run: Run, reason: string, resetsAt: string | null): void {
  const prompt = getPrompt(run.promptId);
  const canResume = getSettings().autoResumeEnabled && (prompt?.autoResume ?? false);
  runs.updateRun(run.id, {
    status: canResume ? 'rate_limited' : 'skipped',
    finishedAt: new Date().toISOString(),
    error: reason,
    rateLimitResetAt: resetsAt,
    autoResumePending: canResume,
    // The run never started, so there is nothing that could already be done.
    completed: false,
    completionReason: 'The run was held back before it started',
  });
  runs.appendEvent(run.id, 'system', { kind: 'quota-guard', reason, resetsAt, willResume: canResume });
  emitUpdate(run.id);
}

async function execute(run: Run): Promise<void> {
  const prompt = getPrompt(run.promptId);
  if (!prompt) {
    finish(run.id, 'failed', { error: 'Prompt was deleted before the run started' });
    return;
  }

  const controller = new AbortController();
  inFlight.set(run.id, controller);

  const startedAt = new Date();
  runs.updateRun(run.id, { status: 'running', startedAt: startedAt.toISOString() });
  emitUpdate(run.id);

  const windows = openWindows(startedAt);
  const settings = getSettings();

  try {
    const result = await runClaude({
      prompt,
      runId: run.id,
      promptText: run.promptText,
      resumeSessionId: run.sessionId,
      globalEnv: settings.globalEnv,
      defaultModel: settings.defaultModel,
      environmentBriefing: settings.environmentBriefing,
      appendSystemPrompt:
        prompt.completionCheck === 'marker' ? markerInstruction(markerFor(prompt)) : undefined,
      signal: controller.signal,
      onEvent: (kind, payload) => {
        const event = runs.appendEvent(run.id, kind, payload);
        bus.emit('run:event', event);
      },
    });

    if (result.usage.totalTokens > 0 || result.usage.costUsd > 0) {
      addUsage(windows.session.id, result.usage);
      addUsage(windows.weekly.id, result.usage);
      bus.emit('quota:changed');
    }

    if (result.sessionId && prompt.continueSession) {
      updatePrompt(prompt.id, { lastSessionId: result.sessionId });
    }

    const finishedAt = new Date();
    const common = {
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      sessionId: result.sessionId,
      exitCode: result.exitCode,
      numTurns: result.numTurns,
      costUsd: result.usage.costUsd,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
      cacheReadTokens: result.usage.cacheReadTokens,
      totalTokens: result.usage.totalTokens,
      resultText: result.resultText,
      model: result.model,
      modelUsage: result.modelUsage,
      durationApiMs: result.durationApiMs,
      serviceTier: result.serviceTier,
    };

    if (result.cancelled) {
      runs.updateRun(run.id, { ...common, status: 'cancelled', error: 'Cancelled' });
    } else if (result.timedOut) {
      runs.updateRun(run.id, {
        ...common,
        status: 'timeout',
        error: `Timed out after ${prompt.timeoutSeconds}s`,
      });
    } else {
      const limit = detectRateLimit(result.resultText, result.stderr, result.subtype);
      if (limit.limited) {
        // Decide whether the task was already done *before* publishing a terminal
        // status, so watchers never see a finished run without its verdict.
        const verdict = await assessCompletion(prompt, {
          runId: run.id,
          resultText: result.resultText,
        });
        const exhaustedRetries = run.resumeAttempt >= prompt.maxAutoResumes;
        const willResume =
          !verdict.completed && settings.autoResumeEnabled && prompt.autoResume && !exhaustedRetries;

        runs.updateRun(run.id, {
          ...common,
          status: 'rate_limited',
          error: `Claude quota reached${limit.evidence ? `: ${limit.evidence}` : ''}`,
          rateLimitResetAt: limit.resetAt,
          completed: verdict.completed,
          completionReason: verdict.reason,
          autoResumePending: willResume,
        });
        runs.appendEvent(run.id, 'system', {
          kind: 'rate-limited',
          scope: limit.scope,
          resetAt: limit.resetAt,
          completed: verdict.completed,
          completionReason: verdict.reason,
          completionCheck: prompt.completionCheck,
          willResume,
          attempt: run.resumeAttempt,
          maxAttempts: prompt.maxAutoResumes,
        });
      } else if (result.isError) {
        runs.updateRun(run.id, {
          ...common,
          status: 'failed',
          error: result.resultText || result.stderr || `Claude exited with code ${result.exitCode}`,
        });
      } else {
        runs.updateRun(run.id, { ...common, status: 'succeeded', error: null });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: message, run: run.id }, 'run failed to execute');
    runs.appendEvent(run.id, 'system', { kind: 'error', message });
    finish(run.id, 'failed', { error: message });
  } finally {
    inFlight.delete(run.id);
    emitUpdate(run.id);
    if (!shuttingDown) void drain();
  }
}

function finish(runId: string, status: RunStatus, patch: Partial<Run>): void {
  const now = new Date().toISOString();
  runs.updateRun(runId, { status, finishedAt: now, ...patch });
  emitUpdate(runId);
}

function emitUpdate(runId: string): void {
  const updated = runs.getRun(runId);
  if (updated) bus.emit('run:updated', updated);
}

export function beginShutdown(): void {
  shuttingDown = true;
  for (const controller of inFlight.values()) controller.abort();
}

export function inFlightRunIds(): string[] {
  return [...inFlight.keys()];
}
