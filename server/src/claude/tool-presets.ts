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
  },
  {
    id: 'repo',
    label: 'Repository work',
    description:
      'Inspection plus file edits, for prompts that clone, change code and push. No web access.',
    allowedTools: EDIT,
    disallowedTools: ['WebSearch', 'WebFetch'],
  },
  {
    id: 'research',
    label: 'Research',
    description: 'Reading and the web, but nothing that writes. For prompts that gather and report.',
    allowedTools: [...INSPECT, 'WebSearch', 'WebFetch'],
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
  },
  {
    id: 'full',
    label: 'Everything',
    description:
      'No restriction. The largest tool schema, so the most tokens spent on every turn of every run.',
    allowedTools: [],
    disallowedTools: [],
  },
];

export function findToolPreset(id: string): ToolPreset | undefined {
  return TOOL_PRESETS.find((preset) => preset.id === id);
}
