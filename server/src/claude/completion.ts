import { logger } from '../logger.js';
import { listEvents } from '../store/runs.js';
import type { CompletionCheck, Prompt } from '../types.js';
import { runOneShot } from './runner.js';

export const DEFAULT_COMPLETION_MARKER = 'KUBECLAUDE_TASK_COMPLETE';
export const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';

export interface CompletionVerdict {
  completed: boolean;
  reason: string;
}

export function markerFor(prompt: Prompt): string {
  return prompt.completionMarker?.trim() || DEFAULT_COMPLETION_MARKER;
}

/**
 * Instruction appended to the system prompt in `marker` mode, so the model knows
 * to announce completion in a way we can detect without another model call.
 */
export function markerInstruction(marker: string): string {
  return (
    `When — and only when — the task you were given is fully finished, output the exact line ` +
    `${marker} as the last line of your final message. ` +
    `If you stop early, run out of budget, or leave anything unfinished, do not output that line. ` +
    `Never output it in any other context, and never as part of a quoted example.`
  );
}

export interface CompletionSubject {
  runId: string;
  resultText: string | null;
}

/** Assistant text from a run, newest last, capped so a judge call stays cheap. */
function transcriptOf(run: CompletionSubject, maxChars = 12_000): string {
  const parts: string[] = [];
  for (const event of listEvents(run.runId)) {
    if (event.kind !== 'message') continue;
    const message = event.payload as Record<string, unknown>;
    if (message.type !== 'assistant') continue;
    const content = (message.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const typed = block as Record<string, unknown>;
      if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text);
      if (typed.type === 'tool_use' && typeof typed.name === 'string') parts.push(`[tool: ${typed.name}]`);
    }
  }
  if (run.resultText) parts.push(run.resultText);

  const joined = parts.join('\n');
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/**
 * The marker must appear on a line of its own so that a model merely discussing
 * the marker — or a quoted instruction echoed back — does not count as done.
 */
export function transcriptHasMarker(transcript: string, marker: string): boolean {
  // Strip only surrounding markdown decoration — the marker itself may well
  // contain underscores, so those must survive.
  const normalise = (line: string) => line.trim().replace(/^[`*\s>-]+/, '').replace(/[`*\s]+$/, '');
  return transcript.split('\n').some((line) => normalise(line) === marker);
}

const JUDGE_PROMPT = (transcript: string) =>
  `You are checking whether an automated coding task finished before it was cut off.

Below is the tail of the assistant transcript. Answer with exactly one word:
- COMPLETE if the task was carried through to the end and nothing is left to do.
- INCOMPLETE if the assistant was still working, announced remaining steps, or was cut off mid-task.

When you are unsure, answer INCOMPLETE.

--- TRANSCRIPT START ---
${transcript}
--- TRANSCRIPT END ---

Answer with one word, COMPLETE or INCOMPLETE.`;

/**
 * Decide whether a run that stopped on a quota limit had already done its job.
 * The answer drives auto-resume: a finished task is left alone, an unfinished one
 * is picked back up when the quota returns.
 */
export async function assessCompletion(
  prompt: Prompt,
  run: CompletionSubject,
): Promise<CompletionVerdict> {
  const mode: CompletionCheck = prompt.completionCheck;

  if (mode === 'never') {
    return { completed: true, reason: 'Auto-resume is disabled for this prompt' };
  }
  if (mode === 'always') {
    return { completed: false, reason: 'This prompt always resumes after a quota stop' };
  }

  const transcript = transcriptOf(run);

  if (mode === 'marker') {
    const marker = markerFor(prompt);
    if (transcriptHasMarker(transcript, marker)) {
      return { completed: true, reason: `The completion marker ${marker} was printed` };
    }
    return { completed: false, reason: `No ${marker} line in the output, so work remains` };
  }

  // judge
  const model = prompt.judgeModel?.trim() || DEFAULT_JUDGE_MODEL;
  if (transcript.trim().length === 0) {
    return { completed: false, reason: 'The run produced no output before it stopped' };
  }
  try {
    const answer = await runOneShot({
      promptText: JUDGE_PROMPT(transcript),
      model,
      timeoutSeconds: 120,
    });
    const verdict = (answer ?? '').toUpperCase();
    if (verdict.includes('INCOMPLETE')) {
      return { completed: false, reason: `${model} judged the task incomplete` };
    }
    if (verdict.includes('COMPLETE')) {
      return { completed: true, reason: `${model} judged the task complete` };
    }
    return { completed: false, reason: `${model} gave no clear verdict, so the task is treated as unfinished` };
  } catch (error) {
    logger.warn({ err: String(error), run: run.runId }, 'completion judge failed');
    // A failed check must not strand the work: resume rather than drop it.
    return { completed: false, reason: 'The completion check failed, so the task is treated as unfinished' };
  }
}
