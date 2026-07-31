import { Cron } from 'croner';
import { config } from './config.js';
import { sweepGoals } from './goals.js';
import { logger } from './logger.js';
import { enqueueRun, drain } from './queue.js';
import * as runs from './store/runs.js';
import { getPrompt } from './store/prompts.js';
import { getSettings } from './store/settings.js';
import { listEnabledTriggers, markFired, updateTrigger } from './store/triggers.js';
import { getActiveWindow, getQuotaState, windowDurationMs } from './store/usage.js';
import type { Trigger, WindowKind } from './types.js';

/**
 * Label a continuation run without stacking prefixes: the third resume of a cron
 * run is `auto_resume:cron`, not `auto_resume:auto_resume:cron`.
 */
export function continuationTriggerType(prefix: string, original: string): string {
  const root = original.replace(/^(auto_resume|manual_resume|manual|follow_up):/, '');
  return `${prefix}:${root}`;
}

export const DEFAULT_RESUME_PROMPT =
  'The previous run stopped because the Claude usage limit was reached. ' +
  'Continue the task from exactly where it left off, without redoing completed work.';

let timer: NodeJS.Timeout | null = null;

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((error) => logger.error({ err: String(error) }, 'scheduler tick failed'));
  }, config.schedulerIntervalMs);
  timer.unref();
  // Evaluate immediately so a restart does not lose a due trigger for a full interval.
  tick().catch((error) => logger.error({ err: String(error) }, 'initial scheduler tick failed'));
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export async function tick(now: Date = new Date()): Promise<void> {
  evaluateTriggers(now);
  sweepAutoResumes(now);
  // After the resume sweep: a goal iteration that the quota interrupted belongs
  // to auto-resume first, and the goal loop only decides once that has settled.
  await sweepGoals(now);
  await drain();
}

// --------------------------------------------------------------------------
// Triggers
// --------------------------------------------------------------------------

export function evaluateTriggers(now: Date): void {
  for (const trigger of listEnabledTriggers()) {
    try {
      const decision = shouldFire(trigger, now);
      if (!decision.fire) {
        if (decision.nextFireAt !== undefined && decision.nextFireAt !== trigger.nextFireAt) {
          updateTrigger(trigger.id, { nextFireAt: decision.nextFireAt });
        }
        continue;
      }

      const prompt = getPrompt(trigger.promptId);
      if (!prompt) continue;

      const run = enqueueRun({
        promptId: trigger.promptId,
        triggerId: trigger.id,
        triggerType: trigger.type,
        skipIfBusy: true,
      });

      // Advance the schedule even when the run was skipped for being busy,
      // otherwise the trigger retries every tick until the prompt frees up.
      markFired(trigger.id, now.toISOString(), decision.nextFireAt ?? null);
      logger.info(
        { trigger: trigger.id, type: trigger.type, prompt: prompt.name, run: run?.id ?? null },
        run ? 'trigger fired' : 'trigger fired but prompt was busy',
      );
    } catch (error) {
      logger.error({ err: String(error), trigger: trigger.id }, 'failed to evaluate trigger');
    }
  }
}

interface FireDecision {
  fire: boolean;
  /** New value for the trigger's `next_fire_at`; undefined means "leave as is". */
  nextFireAt?: string | null;
}

export function shouldFire(trigger: Trigger, now: Date): FireDecision {
  if (!withinMinInterval(trigger, now)) return { fire: false };

  switch (trigger.type) {
    case 'cron':
      return cronDecision(trigger, now);
    case 'interval':
      return intervalDecision(trigger, now);
    case 'session_reset':
      return windowResetDecision(trigger, now, 'session');
    case 'weekly_reset':
      return windowResetDecision(trigger, now, 'weekly');
    case 'quota_available':
      return quotaDecision(trigger, now);
    default:
      return { fire: false };
  }
}

function withinMinInterval(trigger: Trigger, now: Date): boolean {
  const minMinutes = trigger.config.minIntervalMinutes ?? 0;
  if (minMinutes <= 0 || !trigger.lastFiredAt) return true;
  const elapsed = now.getTime() - new Date(trigger.lastFiredAt).getTime();
  return elapsed >= minMinutes * 60_000;
}

function cronDecision(trigger: Trigger, now: Date): FireDecision {
  if (!trigger.cronExpression) return { fire: false };
  let cron: Cron;
  try {
    cron = new Cron(trigger.cronExpression, { timezone: trigger.timezone || 'UTC' });
  } catch (error) {
    logger.warn({ trigger: trigger.id, err: String(error) }, 'invalid cron expression');
    return { fire: false };
  }

  // Anchor on the last fire so a restart does not double-run a due schedule,
  // and so at most one catch-up run happens after downtime.
  const anchor = trigger.lastFiredAt ? new Date(trigger.lastFiredAt) : new Date(trigger.createdAt);
  const due = cron.nextRun(anchor);
  if (due && due.getTime() <= now.getTime()) {
    return { fire: true, nextFireAt: cron.nextRun(now)?.toISOString() ?? null };
  }
  return { fire: false, nextFireAt: due?.toISOString() ?? null };
}

function intervalDecision(trigger: Trigger, now: Date): FireDecision {
  const minutes = trigger.config.intervalMinutes ?? 0;
  if (minutes <= 0) return { fire: false };
  const nextAfter = (from: Date) => new Date(from.getTime() + minutes * 60_000).toISOString();
  if (!trigger.lastFiredAt) return { fire: true, nextFireAt: nextAfter(now) };
  const due = new Date(trigger.lastFiredAt).getTime() + minutes * 60_000;
  if (due <= now.getTime()) return { fire: true, nextFireAt: nextAfter(now) };
  return { fire: false, nextFireAt: new Date(due).toISOString() };
}

/**
 * Fire once per quota window: immediately when no window is open (the allowance
 * is fully reset), then again as soon as the current window rolls over.
 *
 * `next_fire_at` carries the state, so a run started by this trigger — which
 * itself opens the window — cannot re-trigger the same trigger.
 */
function windowResetDecision(trigger: Trigger, now: Date, kind: WindowKind): FireDecision {
  const delayMs = (trigger.config.delayMinutes ?? 0) * 60_000;
  const active = getActiveWindow(kind, now);

  if (trigger.nextFireAt && now.getTime() < new Date(trigger.nextFireAt).getTime()) {
    return { fire: false };
  }

  // The window that will be open once this run starts ends here.
  const windowEnd = active ? new Date(active.endsAt) : new Date(now.getTime() + windowDurationMs(kind));
  const nextFireAt = new Date(windowEnd.getTime() + delayMs).toISOString();

  if (active && delayMs > 0) {
    const readyAt = new Date(active.startedAt).getTime() + delayMs;
    if (now.getTime() < readyAt) return { fire: false, nextFireAt: new Date(readyAt).toISOString() };
  }

  return { fire: true, nextFireAt };
}

/**
 * Fire when enough of the allowance is free again. Falls back to the window
 * reset behaviour when no token budget has been configured, since without a
 * budget "how much is left" is unknowable.
 */
function quotaDecision(trigger: Trigger, now: Date): FireDecision {
  const quota = getQuotaState(now);
  const { minSessionTokensAvailable, minSessionPctAvailable, minWeeklyPctAvailable } = trigger.config;

  if (quota.session.budget <= 0 && quota.weekly.budget <= 0) {
    return windowResetDecision(trigger, now, 'session');
  }

  const sessionOk =
    (minSessionTokensAvailable === undefined ||
      (quota.session.remaining ?? Number.POSITIVE_INFINITY) >= minSessionTokensAvailable) &&
    (minSessionPctAvailable === undefined ||
      (quota.session.remainingPct ?? 100) >= minSessionPctAvailable);

  const weeklyOk =
    minWeeklyPctAvailable === undefined || (quota.weekly.remainingPct ?? 100) >= minWeeklyPctAvailable;

  if (!sessionOk || !weeklyOk) {
    return { fire: false, nextFireAt: quota.session.resetsAt };
  }

  // Without a minimum interval this would fire every tick while quota is free.
  const minMinutes = trigger.config.minIntervalMinutes ?? 60;
  if (trigger.lastFiredAt) {
    const due = new Date(trigger.lastFiredAt).getTime() + minMinutes * 60_000;
    if (due > now.getTime()) return { fire: false, nextFireAt: new Date(due).toISOString() };
  }
  return { fire: true, nextFireAt: new Date(now.getTime() + minMinutes * 60_000).toISOString() };
}

// --------------------------------------------------------------------------
// Auto-resume
// --------------------------------------------------------------------------

/**
 * Re-queue runs that stopped on a quota limit, as soon as the quota is back.
 * The new run resumes the original Claude session so the work continues rather
 * than restarting.
 */
export function sweepAutoResumes(now: Date): void {
  const settings = getSettings();
  const pending = runs.listResumableRuns();
  if (pending.length === 0) return;

  for (const run of pending) {
    const prompt = getPrompt(run.promptId);
    if (!prompt || !prompt.enabled || !prompt.autoResume || !settings.autoResumeEnabled) {
      runs.updateRun(run.id, { autoResumePending: false });
      continue;
    }
    if (run.completed === true) {
      // The task was already finished when the quota ran out; nothing to continue.
      runs.updateRun(run.id, { autoResumePending: false });
      runs.appendEvent(run.id, 'system', {
        kind: 'auto-resume-skipped',
        reason: run.completionReason ?? 'The task was already complete',
      });
      continue;
    }
    if (run.resumeAttempt >= prompt.maxAutoResumes) {
      runs.updateRun(run.id, { autoResumePending: false });
      runs.appendEvent(run.id, 'system', {
        kind: 'auto-resume-abandoned',
        reason: `Reached the maximum of ${prompt.maxAutoResumes} automatic resumes`,
      });
      continue;
    }

    const readyAt = resumeReadyAt(run.rateLimitResetAt, settings.autoResumeDelayMinutes, now);
    if (now.getTime() < readyAt.getTime()) continue;

    // Even once the clock says the quota is back, respect the local guard.
    const quota = getQuotaState(now);
    if (!quota.canRun) continue;

    // Don't stack a resume on top of a run that is already going for this prompt.
    if (runs.hasActiveRunForPrompt(prompt.id)) continue;

    runs.updateRun(run.id, { autoResumePending: false });

    const resumed = enqueueRun({
      promptId: prompt.id,
      triggerId: run.triggerId,
      triggerType: continuationTriggerType('auto_resume', run.triggerType),
      promptText: run.sessionId ? prompt.resumePrompt?.trim() || DEFAULT_RESUME_PROMPT : run.promptText,
      resumeOfRunId: run.id,
      resumeAttempt: run.resumeAttempt + 1,
      sessionId: run.sessionId,
    });

    runs.appendEvent(run.id, 'system', {
      kind: 'auto-resumed',
      resumedBy: resumed?.id ?? null,
      attempt: run.resumeAttempt + 1,
    });
    logger.info(
      { run: run.id, resumedBy: resumed?.id, prompt: prompt.name, attempt: run.resumeAttempt + 1 },
      'auto-resumed a rate-limited run',
    );
  }
}

/**
 * When the quota should be back: Claude's own reset timestamp if it gave one,
 * otherwise the end of the open session window, otherwise right now.
 */
export function resumeReadyAt(rateLimitResetAt: string | null, delayMinutes: number, now: Date): Date {
  const delayMs = Math.max(0, delayMinutes) * 60_000;
  if (rateLimitResetAt) {
    const reset = new Date(rateLimitResetAt);
    if (!Number.isNaN(reset.getTime())) return new Date(reset.getTime() + delayMs);
  }
  const active = getActiveWindow('session', now);
  if (active) return new Date(new Date(active.endsAt).getTime() + delayMs);
  return new Date(now.getTime() + delayMs);
}
