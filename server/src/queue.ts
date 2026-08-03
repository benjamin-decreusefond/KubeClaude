import { config } from './config.js';
import { bus } from './events.js';
import { logger } from './logger.js';
import { runClaude } from './claude/runner.js';
import { detectRateLimit } from './claude/rate-limit.js';
import { assessCompletion, markerFor, markerInstruction } from './claude/completion.js';
import * as runs from './store/runs.js';
import { getPrompt, updatePrompt } from './store/prompts.js';
import { getSettings } from './store/settings.js';
import { recordError } from './store/errors.js';
import { addUsage, currentWindows, getQuotaState, openWindows, recordQuotaReset } from './store/usage.js';
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

/**
 * Stop whatever this prompt is doing, before it is deleted.
 *
 * Without this the Claude process carries on against a prompt that no longer
 * exists — spending quota on work nobody will ever read, and writing output
 * into a run row that has been cascaded away.
 */
export function cancelRunsForPrompt(promptId: string): number {
  let stopped = 0;
  for (const [runId, controller] of inFlight) {
    if (runs.getRun(runId)?.promptId !== promptId) continue;
    controller.abort();
    stopped += 1;
  }
  for (const run of runs.listQueuedRuns()) {
    if (run.promptId !== promptId) continue;
    finish(run.id, 'cancelled', { error: 'Cancelled before it started' });
    stopped += 1;
  }
  return stopped;
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

  // Counts the run against the window it starts in.
  openWindows(startedAt);
  const settings = getSettings();

  try {
    const result = await runClaude({
      prompt,
      runId: run.id,
      promptText: run.promptText,
      resumeSessionId: run.sessionId,
      globalEnv: settings.globalEnv,
      gitIdentity: { name: settings.gitUserName, email: settings.gitUserEmail },
      defaultModel: settings.defaultModel,
      defaultFallbackModel: settings.defaultFallbackModel,
      defaultEffort: settings.defaultEffort,
      environmentBriefing: settings.environmentBriefing,
      defaultMaxTurns: settings.defaultMaxTurns,
      runTokenCap: settings.runTokenCap,
      budgetBasis: settings.budgetBasis,
      appendSystemPrompt:
        prompt.completionCheck === 'marker' ? markerInstruction(markerFor(prompt)) : undefined,
      signal: controller.signal,
      onEvent: (kind, payload) => {
        // Null once the run has been deleted out from under a Claude that is
        // still talking; there is nobody left to tell.
        const event = runs.appendEvent(run.id, kind, payload);
        if (event) bus.emit('run:event', event);
      },
    });

    if (result.usage.totalTokens > 0 || result.usage.costUsd > 0) {
      // Against the window that is live now, not the one this run started in.
      // A run can outlive a 5-hour window, and spend booked to a window that
      // has already closed leaves the guard reading the live one as emptier
      // than it is.
      const windows = currentWindows(new Date());
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
    } else if (result.tokenCapExceeded) {
      // Terminal on purpose. Resuming would restart the same work against the
      // same ceiling and spend the budget twice for the same result, so this is
      // marked finished-not-completed and left for a human to widen or narrow.
      runs.updateRun(run.id, {
        ...common,
        status: 'failed',
        error:
          `Stopped at the per-run ceiling of ${settings.runTokenCap} tokens ` +
          `(${result.weighedTokens} spent). Raise it in Settings or narrow the prompt.`,
        completed: false,
        completionReason: 'token-cap',
        autoResumePending: false,
      });
    } else if (result.turnCapReached) {
      // Not a task that failed: a task that was interrupted by a ceiling. It is
      // resumable — the session is still there and `Resume` picks it up where
      // it stopped — so say which knob to turn rather than leaving a bare
      // failure and a half-finished working tree to explain themselves.
      const cap = prompt.maxTurns ?? settings.defaultMaxTurns;
      runs.updateRun(run.id, {
        ...common,
        status: 'failed',
        error:
          `Stopped after ${result.numTurns ?? cap} turns, at the turn cap of ${cap}. ` +
          'The work is unfinished, not impossible: resume this run to carry on, or raise ' +
          'Max turns on the prompt (or the default in Settings).',
        completed: false,
        completionReason: 'turn-cap',
        autoResumePending: false,
      });
      runs.appendEvent(run.id, 'system', { kind: 'turn-cap', cap, turns: result.numTurns });
    } else if (result.timedOut) {
      runs.updateRun(run.id, {
        ...common,
        status: 'timeout',
        error: `Timed out after ${prompt.timeoutSeconds}s`,
      });
    } else {
      const limit = detectRateLimit(result.resultText, result.stderr, result.subtype);
      if (limit.limited) {
        // Claude just told us when this allowance comes back. Keep it: it is the
        // only moment the truth is on offer, and it outlives this run — the
        // window gauge and the reset trigger both key off it from here.
        if (limit.resetAt) {
          recordQuotaReset({
            // An unattributed limit is the 5-hour one far more often than the
            // weekly one, and treating it as weekly would push the next window
            // days out on a guess.
            kind: limit.scope === 'weekly' ? 'weekly' : 'session',
            resetAt: limit.resetAt,
            runId: run.id,
            evidence: limit.evidence,
          });
        }
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
    // The run records its own failure; this is for the feed, where a fault that
    // hits every run of every prompt is visible as one recurring entry.
    recordError({
      source: 'run',
      message,
      detail: error instanceof Error ? (error.stack ?? null) : null,
      context: `run ${run.id} (${run.promptName})`,
    });
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
