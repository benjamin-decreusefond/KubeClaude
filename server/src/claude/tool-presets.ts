import type { PermissionMode } from '../types.js';

/**
 * Tool sets a prompt can start from.
 *
 * Every tool Claude is allowed to use carries its schema in the system prompt of
 * every request in the run, so the tool list is a fixed tax on each turn. A
 * prompt that only reads the cluster pays for a web browser it will never open
 * unless somebody trims the list — and nobody trims a list they have to write
 * from memory. Hence presets.
 *
 * These are starting points, not policy: the editor writes the lists into the
 * prompt and the user is free to change them afterwards. Permission still gates
 * what a tool may do; this only decides what exists.
 */
export interface ToolPreset {
  id: string;
  label: string;
  description: string;
  allowedTools: string[];
  disallowedTools: string[];
  /**
   * The permission mode the preset implies.
   *
   * The tool lists decide what exists; this decides what may run without a
   * human. A preset that sets only the lists is half a decision: an empty
   * allow list means "the mode decides", so "Everything" applied to a prompt
   * left on `default` grants nothing at all and changes no visible field —
   * which reads as a broken control rather than as a no-op.
   */
  permissionMode: PermissionMode;
}

/** Reading and searching, no writes, no network. The cheapest useful set. */
const INSPECT = ['Read', 'Glob', 'Grep', 'Bash'];

/** Everything in INSPECT plus the file edits real work needs. */
const EDIT = [...INSPECT, 'Write', 'Edit', 'NotebookEdit'];

export const TOOL_PRESETS: ToolPreset[] = [
  {
    id: 'cluster',
    label: 'Cluster inspection',
    description:
      'Read, search and run commands — enough for kubectl, logs and events. No file edits, no web.',
    allowedTools: INSPECT,
    disallowedTools: [],
    // Bash is on the list, and Bash needs approval nobody is here to give.
    // `auto` lets the ordinary calls through and refuses what it flags.
    permissionMode: 'auto',
  },
  {
    id: 'repo',
    label: 'Repository work',
    description:
      'Inspection plus file edits, for prompts that clone, change code and push. No web access.',
    allowedTools: EDIT,
    disallowedTools: ['WebSearch', 'WebFetch'],
    permissionMode: 'auto',
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Reading and the web, but nothing that writes. For prompts that gather and report.',
    allowedTools: [...INSPECT, 'WebSearch', 'WebFetch'],
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    permissionMode: 'auto',
  },
  {
    id: 'full',
    label: 'Everything',
    description:
      'No restriction, and no approval prompts. The largest tool schema, so the most tokens spent on every turn of every run.',
    allowedTools: [],
    disallowedTools: [],
    // The only preset that means it: empty lists plus bypassPermissions is
    // what "no restriction" has to be, since empty lists on their own defer
    // to the mode.
    permissionMode: 'bypassPermissions',
  },
];

export function findToolPreset(id: string): ToolPreset | undefined {
  return TOOL_PRESETS.find((preset) => preset.id === id);
}
