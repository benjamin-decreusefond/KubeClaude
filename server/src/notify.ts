import { logger } from './logger.js';
import { recordError } from './store/errors.js';
import type { Run, Settings } from './types.js';

const TIMEOUT_MS = 5_000;

export type NotifyOutcome = 'success' | 'failure';

/**
 * What a finished run is worth telling somebody about, if anything.
 *
 * A rate-limited run is only worth a page once nothing is going to pick it
 * back up on its own — with an auto-resume pending, it is a pause, not an
 * outcome. `cancelled` is always the operator's own doing, so it never needs
 * telling to the operator.
 */
export function notifyOutcomeFor(run: Pick<Run, 'status' | 'autoResumePending'>): NotifyOutcome | null {
  switch (run.status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'timeout':
    case 'capped':
      return 'failure';
    case 'rate_limited':
      return run.autoResumePending ? null : 'failure';
    default:
      return null;
  }
}

/**
 * Tell whatever is listening — a Slack incoming webhook, a generic endpoint —
 * that a run finished.
 *
 * Fire-and-forget on purpose: a notification target that is slow or down must
 * never hold up the queue that is actually doing the work, so this is never
 * awaited by its caller, and a failure here only ever reaches the error feed,
 * never the run itself.
 */
export function notifyRun(
  run: Run,
  settings: Pick<Settings, 'notifyWebhookUrl' | 'notifyOnSuccess' | 'notifyOnFailure'>,
): void {
  if (!settings.notifyWebhookUrl) return;

  const outcome = notifyOutcomeFor(run);
  if (!outcome) return;
  if (outcome === 'success' && !settings.notifyOnSuccess) return;
  if (outcome === 'failure' && !settings.notifyOnFailure) return;

  const body = {
    text: `KubeClaude: “${run.promptName}” ${outcome === 'success' ? 'succeeded' : 'needs attention'} (${run.status})`,
    outcome,
    run: {
      id: run.id,
      promptId: run.promptId,
      promptName: run.promptName,
      status: run.status,
      triggerType: run.triggerType,
      error: run.error,
      costUsd: run.costUsd,
      totalTokens: run.totalTokens,
      durationMs: run.durationMs,
    },
  };

  fetch(settings.notifyWebhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: message, run: run.id }, 'run notification failed to send');
    recordError({
      source: 'notify',
      message: `Could not reach the notification webhook for run ${run.id}`,
      detail: message,
      context: `run ${run.id} (${run.promptName})`,
    });
  });
}
