import { logger } from './logger.js';
import { enqueueRun } from './queue.js';
import { transcriptOf } from './claude/completion.js';
import { runOneShot } from './claude/runner.js';
import * as goalStore from './store/goals.js';
import { getPrompt } from './store/prompts.js';
import * as runs from './store/runs.js';
import { RESTART_REASON } from './store/runs.js';
import { getQuotaState } from './store/usage.js';
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
const FATAL_RUN_STATUSES: ReadonlySet<string> = new Set(['failed', 'timeout']);

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
    'You are working on a long-running goal, one iteration at a time. End every response with a ' +
    'report in exactly this shape, as the last thing you write:\n\n' +
    'PROGRESS: what you actually changed or learned this iteration, in two or three sentences.\n' +
    'DONE: the ids of the objectives you completed this iteration, comma separated, or none.\n' +
    'NEXT: the single most valuable thing the next iteration should do.\n\n' +
    'Only list an objective under DONE when it is genuinely finished and verified — a later ' +
    'iteration will not revisit it. Never invent an objective id that was not given to you.'
  );
}

function objectiveLine(objective: Objective): string {
  const box = objective.done ? '[x]' : '[ ]';
  const note = objective.done && objective.note ? ` — ${objective.note}` : '';
  return `- ${box} ${objective.id}: ${objective.text}${note}`;
}

/** The message an iteration is started with. */
export function buildIterationPrompt(goal: Goal, history: GoalIteration[]): string {
  const parts: string[] = [`# Goal: ${goal.name}`];
  if (goal.description.trim()) parts.push(goal.description.trim());

  if (goal.objectives.length > 0) {
    const open = goal.objectives.filter((objective) => !objective.done);
    parts.push(
      ['## Objectives', ...goal.objectives.map(objectiveLine)].join('\n') +
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
      'Do one meaningful unit of work towards the goal and carry it through to something real — ' +
      'a change made, a check run, a finding confirmed. Verify it before you claim it. Do not ' +
      'redo work an earlier iteration already finished. Then write the report.',
  );

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
 */
function resolveAchieved(goal: Goal, claimed: string[]): string[] {
  const byId = new Map(goal.objectives.map((objective) => [objective.id.toLowerCase(), objective.id]));
  const byText = new Map(
    goal.objectives.map((objective) => [objective.text.trim().toLowerCase(), objective.id]),
  );
  const resolved = new Set<string>();
  for (const claim of claimed) {
    const key = claim.toLowerCase().replace(/^[[(]|[\])]$/g, '').trim();
    const id = byId.get(key) ?? byText.get(key) ?? byId.get(key.split(/[:\s]/)[0] ?? '');
    if (id) resolved.add(id);
  }
  return [...resolved];
}

function tickObjectives(objectives: Objective[], achieved: string[], note: string): Objective[] {
  if (achieved.length === 0) return objectives;
  const now = new Date().toISOString();
  const trimmed = note.trim();
  return objectives.map((objective) =>
    achieved.includes(objective.id) && !objective.done
      ? {
          ...objective,
          done: true,
          doneAt: now,
          note: trimmed ? trimmed.slice(0, 400) : 'Closed by an iteration',
        }
      : objective,
  );
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

  const objectives = tickObjectives(goal.objectives, achieved, summary);
  return goalStore.updateGoal(goal.id, { objectives });
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

  const promptText = buildIterationPrompt(goal, goalStore.listIterations(goal.id, CONTEXT_ITERATIONS));
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

  goalStore.updateGoal(goal.id, {
    iteration: goal.iteration + 1,
    lastRunId: run.id,
    lastIterationAt: new Date().toISOString(),
  });
  return run;
}

/** True once every objective is ticked; a goal with no objectives never is. */
export function isAchieved(goal: Goal): boolean {
  return goal.objectives.length > 0 && goal.objectives.every((objective) => objective.done);
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
