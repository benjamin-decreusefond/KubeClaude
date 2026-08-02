/**
 * What the caret is currently in the middle of typing.
 *
 * Two triggers, deliberately different in shape because they mean different
 * things. `@` names a file and can appear anywhere in a sentence — "look at
 * @server/src/db.ts and tell me why". `/` inserts a saved prompt's text, and is
 * only a trigger at the very start of an empty-so-far message, because that is
 * the only place inserting a whole prompt makes sense — and because `cd /home`
 * and `https://` must not open a menu.
 */

export type CompletionKind = 'path' | 'prompt';

export interface ActiveToken {
  kind: CompletionKind;
  /** What has been typed after the trigger character. */
  query: string;
  /** Range of the trigger and the query, for replacement. */
  start: number;
  end: number;
}

/** Longest a trigger can stay open; past this it is prose, not a lookup. */
const MAX_QUERY = 120;

export function activeToken(text: string, caret: number): ActiveToken | null {
  const before = text.slice(0, caret);

  if (before.startsWith('/') && !before.slice(1).includes('\n') && before.length - 1 <= MAX_QUERY) {
    return { kind: 'prompt', query: before.slice(1), start: 0, end: caret };
  }

  const at = before.lastIndexOf('@');
  if (at === -1) return null;

  // A trigger only starts a word: `user@example.com` is an address, not a path.
  const preceding = at === 0 ? '' : before[at - 1]!;
  if (preceding && !/\s/.test(preceding)) return null;

  const query = before.slice(at + 1);
  // Whitespace ends it. A path can contain almost anything else, so nothing
  // else does.
  if (/\s/.test(query) || query.length > MAX_QUERY) return null;

  return { kind: 'path', query, start: at, end: caret };
}

export interface Applied {
  text: string;
  caret: number;
}

/**
 * Put the chosen value where the token was.
 *
 * A path is followed by a space, so you can keep typing the sentence it is part
 * of. A prompt is inserted as its whole text and the caret lands at the end of
 * it, ready to be edited before sending.
 */
export function applyCompletion(text: string, token: ActiveToken, value: string): Applied {
  const insert = token.kind === 'path' ? `@${value} ` : value;
  const next = text.slice(0, token.start) + insert + text.slice(token.end);
  return { text: next, caret: token.start + insert.length };
}
