import { expect, test } from 'vitest';
import { activeToken, applyCompletion } from './completion';

/** Where the caret is, written as `|` for legibility. */
function at(withCaret: string): { text: string; caret: number } {
  const caret = withCaret.indexOf('|');
  return { text: withCaret.replace('|', ''), caret };
}

function token(withCaret: string) {
  const { text, caret } = at(withCaret);
  return activeToken(text, caret);
}

test('@ opens a path lookup, wherever it appears in a sentence', () => {
  expect(token('@|')).toMatchObject({ kind: 'path', query: '' });
  expect(token('look at @server/src/db|')).toMatchObject({ kind: 'path', query: 'server/src/db' });
  expect(token('@src/a.ts|')).toMatchObject({ kind: 'path', start: 0 });
});

test('@ in the middle of a word is not a trigger', () => {
  // An email address, and a decorator that is part of an identifier.
  expect(token('ben@example|')).toBeNull();
  expect(token('name@|')).toBeNull();
});

test('a space ends a path token', () => {
  expect(token('@src/db.ts done|')).toBeNull();
});

test('/ opens the prompt list only at the very start of the message', () => {
  expect(token('/|')).toMatchObject({ kind: 'prompt', query: '', start: 0 });
  expect(token('/nightly|')).toMatchObject({ kind: 'prompt', query: 'nightly' });

  // The two cases that would otherwise pop a menu mid-sentence.
  expect(token('cd /home|')).toBeNull();
  expect(token('see https://example.com/|')).toBeNull();
});

test('/ stops being a trigger once the message has a second line', () => {
  expect(token('/nightly\nand then|')).toBeNull();
});

test('a path replaces its token and leaves you mid-sentence', () => {
  const { text, caret } = at('look at @src/d| and say why');
  const applied = applyCompletion(text, activeToken(text, caret)!, 'server/src/db.ts');

  expect(applied.text).toBe('look at @server/src/db.ts  and say why');
  // Caret sits after the inserted path and its trailing space.
  expect(applied.text.slice(0, applied.caret)).toBe('look at @server/src/db.ts ');
});

test('a prompt is inserted as its whole text, with nothing left of the trigger', () => {
  const { text, caret } = at('/night|');
  const applied = applyCompletion(text, activeToken(text, caret)!, 'Check the cluster and report.');

  expect(applied.text).toBe('Check the cluster and report.');
  expect(applied.caret).toBe(applied.text.length);
});
