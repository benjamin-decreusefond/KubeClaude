import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

// runner.ts reaches config, which reads the environment once at import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kubeclaude-linesplit-'));
process.env.DATA_DIR = tmpDir;

const { lineSplitter } = await import('../src/claude/runner.js');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** Feed `bytes` through the splitter, broken at exactly `cut`. */
function feedSplitAt(bytes: Buffer, cut: number): string[] {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line));
  feed(bytes.subarray(0, cut));
  feed(bytes.subarray(cut));
  return lines;
}

test('a character split across two chunks survives it', () => {
  const text = 'checked the café — 200 € saved 🎉';
  const bytes = Buffer.from(`${JSON.stringify({ type: 'assistant', text })}\n`, 'utf8');

  // Every byte boundary, including the ones inside each multi-byte character.
  // Decoding a chunk on its own turns the leading half into a replacement
  // character, and because it lands inside a JSON string the line still parses
  // — so nothing anywhere reports that the text is now wrong.
  for (let cut = 1; cut < bytes.length; cut += 1) {
    const lines = feedSplitAt(bytes, cut);
    assert.equal(lines.length, 1, `expected one line when split at ${cut}`);
    const parsed = JSON.parse(lines[0]!) as { text: string };
    assert.equal(parsed.text, text, `text was corrupted when split at byte ${cut}`);
  }
});

test('a line is only delivered once its newline has arrived', () => {
  const bytes = Buffer.from('{"a":1}\n{"b":2}\n', 'utf8');
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line));

  feed(bytes.subarray(0, 4));
  assert.deepEqual(lines, [], 'nothing is complete yet');

  feed(bytes.subarray(4));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test('a trailing partial line is held rather than delivered broken', () => {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line));

  feed(Buffer.from('{"done":true}\n{"partial":', 'utf8'));
  assert.deepEqual(lines, ['{"done":true}'], 'the unterminated line waits for its newline');
});

test('blank lines between messages are skipped, not delivered as empty', () => {
  const lines: string[] = [];
  const feed = lineSplitter((line) => lines.push(line));

  feed(Buffer.from('{"a":1}\n\n   \n{"b":2}\n', 'utf8'));
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});
