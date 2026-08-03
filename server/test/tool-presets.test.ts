import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_PRESETS, findToolPreset } from '../src/claude/tool-presets.js';

test('every preset declares the permission mode it implies', () => {
  // The tool lists decide what exists; the mode decides what may run. A preset
  // that sets only the lists leaves the second half of the decision unmade, and
  // an empty allow list defers to the mode — so a preset without one can be a
  // complete no-op.
  for (const preset of TOOL_PRESETS) {
    assert.ok(preset.permissionMode, `${preset.id} has no permission mode`);
  }
});

test('the "everything" preset actually grants everything', () => {
  const full = findToolPreset('full');
  assert.ok(full);
  // Empty lists mean "the mode decides", so this is the only combination that
  // makes "no restriction" true rather than a relabelled default.
  assert.deepEqual(full.allowedTools, []);
  assert.deepEqual(full.disallowedTools, []);
  assert.equal(full.permissionMode, 'bypassPermissions');
});

test('no preset leaves an unattended run unable to use the tools it lists', () => {
  // `default` denies anything needing approval, and every preset lists at least
  // one tool that needs it — so `default` would mean the preset grants nothing.
  for (const preset of TOOL_PRESETS) {
    assert.notEqual(preset.permissionMode, 'default', `${preset.id} would stall on approval`);
    assert.notEqual(preset.permissionMode, 'plan', `${preset.id} would change nothing`);
  }
});
