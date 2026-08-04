import { logger } from './logger.js';
import { enqueueRun } from './queue.js';
import { transcriptOf } from './claude/completion.js';
import { runOneShot } from './claude/runner.js';
import * as goalStore from './store/goals.js';
import { getPrompt, updatePrompt } from './store/prompts.js';
import * as runs from './store/runs.js';
import { RESTART_REASON } from './store/runs.js';
import { getActiveWindow, getQuotaState, type QuotaSlice } from './store/usage.js';
import type { Goal, GoalIteration, Objective, Run } from './types.js';

/**
 * The loop, in one place.
 *
 * A goal is a prompt that never finishes. Each iteration resumes the same
 * Claude session, is told what the goal is, which objectives are still open and
 * what the last iterations achieved, and is asked to do the next most valuable
 * thing. When the run ends its report is parsed, objectives are ticked off, and
 * the next iteration is scheduled — until every objective is met, the iteration
 * budget runs out, or a human pauses it.
 */

/** Terminal statuses that mean the iteration ran and produced something to read. */
const REVIEWABLE: ReadonlySet<string> = new Set(['succeeded']);

/** Statuses that mean the loop should stop rather than keep burning tokens. */
const FATAL_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'timeout', 'capped']);

/**
 * Statuses that mean the allowance ran out, not that the work went wrong.
 *
 * These are not fatal: running out of credit is a wait, not a fault, and a goal
 * that paused itself over it would stay paused long after the quota came back —
 * with nothing to notice. What they must not do is spin, so the loop holds the
 * goal until the allowance is actually due back (`quotaHoldUntil`) rather than
 * retrying every cadence tick against an empty window.
 */
const QUOTA_RUN_STATUSES: ReadonlySet<string> = new Set(['rate_limited', 'skipped']);

/**
 * How long to wait before trying again when the quota stopped an iteration and
 * nothing said when it comes back. Long enough not to spin, short enough that a
 * goal picks up again reasonably soon after the allowance returns.
 */
const BLIND_QUOTA_RETRY_MINUTES = 30;

/**
 * What the log calls an iteration the process was restarted out of. Not one of
 * the fatal statuses on purpose: a restart is a deploy or a node drain, not the
 * task failing, and a goal that deploys anything would otherwise stop itself
 * after three of its own deployments.
 */
const INTERRUPTED = 'interrupted';

/** How many consecutive fruitless iterations are tolerated before giving up. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Progress notes carried into the next iteration; older ones are just noise. */
const CONTEXT_ITERATIONS = 5;

/**
 * Appended to the system prompt of every goal run. The report is how an
 * iteration hands its state to the next one, so it has to be unmissable and
 * mechanically parseable — a prose summary would need a model call to read.
 */
export function iterationReportInstruction(): string {
  return (
    'You are working on a long-running goal, one iteration at a time. An iteration is a working ' +
    'session rather than a single step, but it is not unlimited either: carry the thread you ' +
    'picked up through to a clean handover point, then hand over. End every response with a ' +
    'report in exactly this shape, as the last thing you write:\n\n' +
    'PROGRESS: what you actually changed or learned this iteration, in two or three sentences.\n' +
    'DONE: the ids of the objectives you completed this iteration, comma separated, or none.\n' +
    'NEXT: the single most valuable thing the next iteration should do.\n\n' +
    'Only list an objective under DONE when it is genuinely finished and verified — a later ' +
    'iteration will not revisit it. Never invent an objective id that was not given to you, and ' +
    'never list a standing objective: those are missions to keep working at, not boxes to tick.'
  );
}

function objectiveLine(objective: Objective): string {
  if (objective.continuous) return `- [~] ${objective.id}: ${objective.text} (standing)`;
  const box = objective.done ? '[x]' : '[ ]';
  const note = objective.done && objective.note ? ` — ${objective.note}` : '';
  return `- ${box} ${objective.id}: ${objective.text}${note}`;
}

/**
 * Why stopping early costs something, in the goal's own numbers. An iteration
 * that ends on "waiting for CI" does not resume when CI finishes — it resumes
 * when the cadence says so, which is the part worth spelling out.
 */
function cadenceSentence(goal: Goal): string {
  const minutes = Math.max(0, goal.cadenceMinutes);
  if (minutes === 0) return 'nothing else happens on this goal until the next iteration starts.';
  return `nothing else happens on this goal for the next ${minutes} minutes.`;
}

/** "in about 40 minutes", "in about 3 hours" — enough to pace a session by. */
function roughly(iso: string, now: Date): string | null {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  if (minutes < 90) return `in about ${minutes} minutes`;
  return `in about ${Math.round(minutes / 60)} hours`;
}

/**
 * How much of the token window is left, and what to do about it.
 *
 * The iteration is told to stop at a clean handover point rather than at the
 * bottom of the budget, but "leave some margin" means nothing without a number
 * — and the number is right here, so there is no reason to make the model
 * guess it. When no budget is configured there is nothing honest to say, and
 * the section is left out entirely.
 */
function budgetSection(quota: QuotaSlice | null | undefined, now: Date): string | null {
  if (!quota || quota.remainingPct === null) return null;
  const pct = Math.round(quota.remainingPct);
  const resets = quota.resetsAt ? roughly(quota.resetsAt, now) : null;
  const when = resets ? ` It resets ${resets}.` : '';

  if (pct <= LOW_BUDGET_PCT) {
    return (
      `## Budget\nOnly ${pct}% of the current token window is left.${when} Land something small ` +
      'and finish cleanly rather than starting anything that needs the rest of it.'
    );
  }
  return (
    `## Budget\n${pct}% of the current token window is still free.${when} Spend some of it, not ` +
    'all of it — every other prompt, goal and chat on this instance draws on the same window, ' +
    'and a goal that empties it stops itself until the reset.'
  );
}

/** Below this share of the budget, an iteration should be winding down, not starting. */
const LOW_BUDGET_PCT = 25;

/**
 * The message an iteration is started with. `quota` is the token window it will
 * be spending from; pass null when there is none to speak of.
 */
export function buildIterationPrompt(
  goal: Goal,
  history: GoalIteration[],
  quota: QuotaSlice | null = null,
  now: Date = new Date(),
): string {
  const parts: string[] = [`# Goal: ${goal.name}`];
  if (goal.description.trim()) parts.push(goal.description.trim());

  if (goal.objectives.length > 0) {
    const open = goal.objectives.filter((objective) => !objective.done);
    const standing = goal.objectives.some((objective) => objective.continuous);
    parts.push(
      ['## Objectives', ...goal.objectives.map(objectiveLine)].join('\n') +
        (standing
          ? '\n\nThe ones marked [~] are standing: no amount of work finishes them, so never ' +
            'report them under DONE. They are what you keep coming back to once the closable ' +
            'objectives are out of the way — each iteration should push them further, not ' +
            'declare them met.'
          : '') +
        (open.length === 0
          ? '\n\nEvery objective is ticked. Look for what would genuinely improve on this, or ' +
            'report that there is nothing left worth doing.'
          : ''),
    );
  } else {
    parts.push(
      '## Objectives\nNone were listed. Work out what would most improve this goal, do it, and ' +
        'report what you did.',
    );
  }

  const recent = history.slice(-CONTEXT_ITERATIONS);
  if (recent.length > 0) {
    parts.push(
      [
        '## What earlier iterations did',
        ...recent.map((entry) => {
          const done = entry.achieved.length > 0 ? ` (closed ${entry.achieved.join(', ')})` : '';
          return `${entry.seq}. ${entry.summary || 'no report'}${done}`;
        }),
      ].join('\n'),
    );
    const next = recent[recent.length - 1]?.nextStep?.trim();
    if (next) parts.push(`## What the last iteration said to do next\n${next}`);
  }

  parts.push(
    `## This iteration (#${goal.iteration + 1})\n` +
      'This is a working session, not a single step. Pick up the most valuable thread and carry ' +
      'it all the way through — found, fixed, tested, verified, landed. Verify what you claim ' +
      'before you claim it, and do not redo work an earlier iteration already finished. Waiting ' +
      'on something external — a build, a check, a deployment — is not being blocked: wait for it ' +
      'and finish the job rather than handing over something half-landed, because ' +
      `${cadenceSentence(goal)}\n\n` +
      'Then stop at the first clean handover point — the work landed, nothing left dangling. ' +
      'One or two threads carried through is an iteration. A single check or a one-line ' +
      'confirmation is less than one; working until you run out of things to do, or out of ' +
      'quota, is more than one, and this loop is meant to last. Whatever you did not get to ' +
      'goes in NEXT, and the same session picks it up next time.',
  );

  const budget = budgetSection(quota, now);
  if (budget) parts.push(budget);

  parts.push('Then write the report.');

  return parts.join('\n\n');
}

export interface IterationReport {
  progress: string;
  achieved: string[];
  next: string | null;
}

/**
 * Everything after `LABEL:` up to the next label or the end of the text. The
 * match is case-sensitive on purpose: prose runs into "done:" and "next:" all
 * the time, and a stray one of those must not be read as a report.
 */
function section(text: string, label: string): string | null {
  const pattern = new RegExp(
    `^[\\s>*\\-#\`]*${label}\\s*:\\s*([\\s\\S]*?)(?=^[\\s>*\\-#\`]*(?:PROGRESS|DONE|NEXT)\\s*:|$(?![\\s\\S]))`,
    'm',
  );
  const match = pattern.exec(text);
  const body = match?.[1]?.trim();
  return body ? body.replace(/[`*]+$/, '').trim() : null;
}

/**
 * Read the report an iteration was asked to end with. Returns null when there
 * is nothing to read — the caller decides whether that is worth a judge call.
 */
export function parseIterationReport(text: string | null): IterationReport | null {
  if (!text) return null;
  const progress = section(text, 'PROGRESS');
  const done = section(text, 'DONE');
  const next = section(text, 'NEXT');
  // A lone label with nothing behind it says as little as no report at all, and
  // claiming otherwise would rob the review model of its turn.
  if (!progress && !done && !next) return null;

  return {
    progress: progress ?? '',
    achieved: parseAchieved(done),
    next: next && !/^none$/i.test(next) ? next : null,
  };
}

function parseAchieved(done: string | null): string[] {
  if (!done || /^(none|n\/a|-|nothing)\b/i.test(done.trim())) return [];
  return [
    ...new Set(
      done
        .split(/[,\n;]/)
        .map((piece) => piece.trim().replace(/^[-*\s]+/, '').replace(/[.\s]+$/, ''))
        .filter((piece) => piece.length > 0),
    ),
  ];
}

const JUDGE_PROMPT = (goal: Goal, transcript: string) =>
  `An automated agent worked one iteration on this goal:

Goal: ${goal.name}
${goal.description}

Objectives:
${goal.objectives.map((objective) => `${objective.id}: ${objective.text}${objective.done ? ' (already done)' : ''}`).join('\n') || '(none listed)'}

Below is the tail of what it did. Reply with JSON only, no prose, in this shape:
{"progress": "two sentences on what it accomplished", "done": ["objective ids it finished this time"], "next": "the most valuable next step"}

Only list an objective under "done" when the transcript shows it finished and verified.

--- TRANSCRIPT START ---
${transcript}
--- TRANSCRIPT END ---`;

async function judgeIteration(goal: Goal, run: Run): Promise<IterationReport | null> {
  const model = goal.reviewModel?.trim();
  if (!model) return null;

  const transcript = transcriptOf({ runId: run.id, resultText: run.resultText });
  if (transcript.trim().length === 0) return null;

  try {
    const answer = await runOneShot({ promptText: JUDGE_PROMPT(goal, transcript), model, timeoutSeconds: 120 });
    const json = answer?.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const parsed = JSON.parse(json) as { progress?: unknown; done?: unknown; next?: unknown };
    return {
      progress: typeof parsed.progress === 'string' ? parsed.progress : '',
      achieved: Array.isArray(parsed.done) ? parsed.done.filter((id): id is string => typeof id === 'string') : [],
      next: typeof parsed.next === 'string' && parsed.next.trim() ? parsed.next.trim() : null,
    };
  } catch (error) {
    logger.warn({ err: String(error), goal: goal.id, run: run.id }, 'goal review failed');
    return null;
  }
}

/**
 * Match what the model claimed against the objectives it was given, by id or by
 * the objective's own text. Anything else it named is dropped: a goal must not
 * be able to tick a box that was never on the list.
 *
 * Standing objectives are not on the list for this purpose. "Keep it secure" is
 * never finished, and an iteration that fixed three security bugs will honestly
 * believe it just met that objective — which would tick it, drop it out of the
 * open set, and leave the loop with nothing to aim at.
 */
function resolveAchieved(goal: Goal, claimed: string[]): string[] {
  const closable = goal.objectives.filter((objective) => !objective.continuous);
  const byId = new Map(closable.map((objective) => [objective.id.toLowerCase(), objective.id]));
  const byText = new Map(
    closable.map((objective) => [objective.text.trim().toLowerCase(), objective.id]),
  );
  const resolved = new Set<string>();
  for (const claim of claimed) {
    const key = claim.toLowerCase().replace(/^[[(]|[\])]$/g, '').trim();
    const id = byId.get(key) ?? byText.get(key) ?? byId.get(key.split(/[:\s]/)[0] ?? '');
    if (id) resolved.add(id);
  }
  return [...resolved];
}

/**
 * Turn a finished iteration run into a progress entry and tick off whatever it
 * closed. Returns the goal as it now stands, or null when the run was not one
 * this goal is waiting on.
 */
export async function reviewIteration(goal: Goal, run: Run): Promise<Goal | null> {
  if (goalStore.hasIterationForRun(run.id)) return goal;

  let report: IterationReport | null = null;
  let source: GoalIteration['source'] = 'none';

  if (REVIEWABLE.has(run.status)) {
    report = parseIterationReport(run.resultText);
    if (report) source = 'report';
    else {
      report = await judgeIteration(goal, run);
      if (report) source = 'judge';
    }
  }

  const achieved = report ? resolveAchieved(goal, report.achieved) : [];
  const summary = report?.progress?.trim() || fallbackSummary(run);

  goalStore.addIteration({
    goalId: goal.id,
    runId: run.id,
    summary,
    nextStep: report?.next ?? null,
    achieved,
    source,
    runStatus: wasRestarted(run) ? INTERRUPTED : run.status,
  });

  // Against the goal as it stands now: an iteration takes minutes, and somebody
  // may well have added an objective while this one was working.
  return goalStore.tickObjectives(goal.id, achieved, summary);
}

/** True when this run died because KubeClaude itself was restarted under it. */
function wasRestarted(run: Run): boolean {
  return run.status === 'failed' && run.completionReason === RESTART_REASON;
}

function fallbackSummary(run: Run): string {
  if (wasRestarted(run)) {
    return 'KubeClaude restarted while this iteration was running, so it stopped part-way. Nothing is known about what it had done.';
  }
  if (run.status === 'succeeded') return 'The iteration finished without a readable report.';
  if (run.error) return `The iteration ended as ${run.status}: ${run.error}`;
  return `The iteration ended as ${run.status}.`;
}

/** Queue the next iteration of a goal. Returns the run, or null if it could not start. */
export function startIteration(goal: Goal, triggerType = 'goal'): Run | null {
  const prompt = getPrompt(goal.promptId);
  if (!prompt) return null;
  if (runs.hasActiveRunForPrompt(prompt.id)) return null;

  // The report instruction is written into the prompt when the goal is created,
  // so a goal made before this wording changed would keep the old one forever.
  // Nothing else may edit it — goals do not expose `appendSystemPrompt` — so
  // overwriting it here cannot clobber anybody's own text.
  const instruction = iterationReportInstruction();
  if (prompt.appendSystemPrompt !== instruction) {
    updatePrompt(prompt.id, { appendSystemPrompt: instruction });
  }

  const now = new Date();
  const promptText = buildIterationPrompt(
    goal,
    goalStore.listIterations(goal.id, CONTEXT_ITERATIONS),
    // The 5-hour window rather than the weekly one: it is the one an iteration
    // can actually empty in a single sitting.
    getQuotaState(now).session,
    now,
  );
  const run = enqueueRun({
    promptId: prompt.id,
    triggerType,
    promptText,
    // Resuming the previous iteration's session is what makes this one loop
    // rather than a series of strangers; `continueSession` supplies the id.
    resumeOfRunId: goal.lastRunId,
    skipIfBusy: true,
  });
  if (!run) return null;

  goalStore.recordIterationStart(goal.id, run.id);
  return run;
}

/**
 * True once every objective is ticked; a goal with no objectives never is, and
 * neither is one carrying a standing objective — that is the whole point of
 * marking one, so a hand-ticked box must not end the goal either.
 */
export function isAchieved(goal: Goal): boolean {
  return goal.objectives.length > 0 && goal.objectives.every((objective) => objective.done && !objective.continuous);
}

/**
 * When a goal stopped by the quota should try again: Claude's own reset time if
 * it gave one, otherwise the end of the open session window, otherwise a flat
 * wait. The last case is the one that matters — with no budget configured and
 * no reset in the message there is nothing to key off, and retrying every
 * cadence tick would be the spin this whole branch exists to avoid.
 */
function quotaHoldUntil(run: Run, now: Date): Date {
  if (run.rateLimitResetAt) {
    const reset = new Date(run.rateLimitResetAt);
    if (!Number.isNaN(reset.getTime())) return reset;
  }
  const window = getActiveWindow('session', now);
  if (window) return new Date(window.endsAt);

  const from = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  return new Date(from + BLIND_QUOTA_RETRY_MINUTES * 60_000);
}

/** How many iterations in a row ended without producing anything usable. */
function consecutiveFailures(goalId: string): number {
  let count = 0;
  for (const entry of [...goalStore.listIterations(goalId, MAX_CONSECUTIVE_FAILURES)].reverse()) {
    if (entry.runStatus && FATAL_RUN_STATUSES.has(entry.runStatus)) count += 1;
    else break;
  }
  return count;
}

/**
 * One pass of the loop: review whatever finished, then start what is due.
 * Called from the scheduler tick, so it must never throw for one bad goal.
 */
export async function sweepGoals(now: Date = new Date()): Promise<void> {
  for (const stored of goalStore.listActiveGoals()) {
    try {
      await advanceGoal(stored, now);
    } catch (error) {
      logger.error({ err: String(error), goal: stored.id }, 'failed to advance a goal');
    }
  }
}

async function advanceGoal(stored: Goal, now: Date): Promise<void> {
  let goal = stored;

  const prompt = getPrompt(goal.promptId);
  if (!prompt) {
    goalStore.updateGoal(goal.id, { status: 'abandoned' });
    return;
  }

  // The newest run rather than `lastRunId`: an iteration stopped by the quota is
  // picked up by the auto-resume sweep, and it is that continuation — not the
  // interrupted run — whose report counts.
  const last = runs.listRuns({ promptId: goal.promptId, limit: 1 })[0] ?? null;

  // Still working, or waiting on the quota to come back: nothing to decide yet.
  if (last && (last.status === 'queued' || last.status === 'running')) return;
  if (last && last.status === 'rate_limited' && last.autoResumePending) return;

  if (last) {
    const reviewed = await reviewIteration(goal, last);
    if (reviewed) goal = reviewed;
  }

  if (isAchieved(goal) && goal.stopWhenAchieved) {
    goalStore.updateGoal(goal.id, { status: 'achieved' });
    logger.info({ goal: goal.id, name: goal.name }, 'goal achieved');
    return;
  }

  if (goal.maxIterations > 0 && goal.iteration >= goal.maxIterations) {
    goalStore.updateGoal(goal.id, { status: 'abandoned' });
    logger.info({ goal: goal.id, name: goal.name }, 'goal stopped at its iteration limit');
    return;
  }

  if (consecutiveFailures(goal.id) >= MAX_CONSECUTIVE_FAILURES) {
    // Something is wrong with the setup rather than the work; looping on it
    // would spend the budget reproducing the same failure.
    goalStore.updateGoal(goal.id, { status: 'paused' });
    logger.warn({ goal: goal.id, name: goal.name }, 'goal paused after repeated failed iterations');
    return;
  }

  if (!prompt.enabled) return;

  // The allowance ran out rather than the work going wrong. Wait for it to come
  // back — the goal stays active, so it picks itself up without anybody having
  // to notice it had stopped.
  if (last && QUOTA_RUN_STATUSES.has(last.status)) {
    const until = quotaHoldUntil(last, now);
    if (now.getTime() < until.getTime()) return;
  }

  // Cadence is measured from the end of the last iteration, so a long run does
  // not immediately get another one stacked behind it.
  const since = last?.finishedAt ?? goal.lastIterationAt;
  if (since) {
    const due = new Date(since).getTime() + Math.max(0, goal.cadenceMinutes) * 60_000;
    if (now.getTime() < due) return;
  }

  // Let the guard say no here rather than queue a run that would be parked and
  // logged as a failed iteration through no fault of its own.
  if (!getQuotaState(now).canRun) return;

  const run = startIteration(goal);
  if (run) {
    logger.info(
      { goal: goal.id, name: goal.name, run: run.id, iteration: goal.iteration + 1 },
      'started a goal iteration',
    );
  }
}
