export interface ModelOption {
  /** Value passed to `claude --model`. */
  id: string;
  label: string;
  description: string;
  /** Aliases are resolved by the CLI to whatever is current for the account. */
  kind: 'alias' | 'model';
}

/**
 * Suggestions for the model picker. The CLI accepts any model id the account can
 * reach, so the UI also allows free text — this list is a convenience, not a limit.
 */
export const MODEL_CATALOG: ModelOption[] = [
  {
    id: '',
    label: 'Account default',
    description: 'Whatever the Claude CLI would pick on its own.',
    kind: 'alias',
  },
  {
    id: 'opus',
    label: 'Opus (alias)',
    description: 'Most capable tier; the alias always tracks the current Opus.',
    kind: 'alias',
  },
  {
    id: 'sonnet',
    label: 'Sonnet (alias)',
    description: 'Balanced capability and speed; tracks the current Sonnet.',
    kind: 'alias',
  },
  {
    id: 'haiku',
    label: 'Haiku (alias)',
    description: 'Fastest and cheapest; tracks the current Haiku.',
    kind: 'alias',
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    description: 'Best for long, multi-step work such as driving a PR to merge.',
    kind: 'model',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    description: 'Strong default for scheduled maintenance and review tasks.',
    kind: 'model',
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    description: 'Tuned for writing-heavy work.',
    kind: 'model',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Claude Haiku 4.5',
    description: 'Cheap enough to run often; good for triage and summaries.',
    kind: 'model',
  },
];
