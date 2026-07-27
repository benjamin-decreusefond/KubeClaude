import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_COMPLETION_MARKER,
  markerInstruction,
  transcriptHasMarker,
} from '../src/claude/completion.js';

const MARKER = DEFAULT_COMPLETION_MARKER;

test('finds the marker on a line of its own', () => {
  assert.equal(transcriptHasMarker(`all done\n${MARKER}`, MARKER), true);
  assert.equal(transcriptHasMarker(`${MARKER}`, MARKER), true);
  assert.equal(transcriptHasMarker(`done\n  ${MARKER}  \n`, MARKER), true);
});

test('sees through markdown decoration around the marker', () => {
  assert.equal(transcriptHasMarker(`**${MARKER}**`, MARKER), true);
  assert.equal(transcriptHasMarker(`\`${MARKER}\``, MARKER), true);
  assert.equal(transcriptHasMarker(`- ${MARKER}`, MARKER), true);
});

test('underscores inside the marker are preserved', () => {
  // Regression: stripping markdown emphasis must not eat the marker's own _.
  assert.ok(MARKER.includes('_'));
  assert.equal(transcriptHasMarker(MARKER, MARKER), true);
});

test('ignores the marker when it is only mentioned in prose', () => {
  assert.equal(
    transcriptHasMarker(`I will print ${MARKER} once the work is finished.`, MARKER),
    false,
  );
  assert.equal(transcriptHasMarker(`Not done yet, so no ${MARKER} for now`, MARKER), false);
});

test('an empty transcript has no marker', () => {
  assert.equal(transcriptHasMarker('', MARKER), false);
});

test('a custom marker works the same way', () => {
  assert.equal(transcriptHasMarker('worked\nALL_DONE', 'ALL_DONE'), true);
  assert.equal(transcriptHasMarker('worked\nALL_DONE_MAYBE', 'ALL_DONE'), false);
});

test('the instruction names the marker and warns against stray use', () => {
  const instruction = markerInstruction('ALL_DONE');
  assert.match(instruction, /output the exact line ALL_DONE/);
  assert.match(instruction, /do not output that line/i);
});
