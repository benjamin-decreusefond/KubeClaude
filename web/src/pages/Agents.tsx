import { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Card, Checkbox, Empty, Field, Modal } from '../components/primitives';
import { usePolled } from '../hooks';
import type { AgentDefinition } from '../types';

const EXAMPLES: Array<{ label: string; name: string; config: string }> = [
  {
    label: 'Code reviewer',
    name: 'reviewer',
    config: JSON.stringify(
      {
        description: 'Reviews a diff for correctness before it is pushed',
        prompt:
          'You are a meticulous code reviewer. Read the diff and report only defects that would change behaviour — no style nits.',
      },
      null,
      2,
    ),
  },
  {
    label: 'Test writer',
    name: 'tester',
    config: JSON.stringify(
      {
        description: 'Writes and runs tests for a change',
        prompt: 'You write focused tests for the change at hand, run them, and fix what fails.',
        tools: ['Read', 'Edit', 'Bash'],
      },
      null,
      2,
    ),
  },
  {
    label: 'Research-only',
    name: 'researcher',
    config: JSON.stringify(
      {
        description: 'Searches the codebase and reports back without editing anything',
        prompt: 'You investigate and summarize; you never edit files.',
        tools: ['Read', 'Grep', 'Glob'],
        model: 'haiku',
      },
      null,
      2,
    ),
  },
];

export function Agents() {
  const { data: agents, refresh } = usePolled<AgentDefinition[]>(() => api.agents(), 0);
  const [editing, setEditing] = useState<AgentDefinition | 'new' | null>(null);

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Agents</h1>
          <p>
            Reusable subagents a prompt can delegate to. Saved once here, then attached to any prompt by
            name — the same way an MCP connection is, instead of retyping the same reviewer or tester into
            every prompt's inline <code>--agents</code> JSON.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing('new')}>
          Add agent
        </button>
      </header>

      <Banner icon="i">
        This is a definition, not a process — nothing runs until a prompt with this agent attached is
        itself run. Claude decides on its own when a subagent is worth delegating to.
      </Banner>

      {agents?.length === 0 && (
        <Card>
          <Empty>No agents yet.</Empty>
        </Card>
      )}

      {agents?.map((agent) => (
        <Card
          key={agent.id}
          title={
            <span className="row">
              <code>{agent.name}</code>
              {!agent.enabled && <Badge>Disabled</Badge>}
            </span>
          }
          subtitle={agent.description}
          actions={
            <>
              <button className="ghost small" onClick={() => setEditing(agent)}>
                Edit
              </button>
              <button
                className="ghost small"
                onClick={() => void api.updateAgent(agent.id, { enabled: !agent.enabled }).then(refresh)}
              >
                {agent.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                className="ghost small"
                onClick={() => {
                  if (!confirm(`Remove the ${agent.name} agent?`)) return;
                  void api.deleteAgent(agent.id).then(refresh);
                }}
              >
                ✕
              </button>
            </>
          }
        >
          <div className="mono-block">{agent.config}</div>
        </Card>
      ))}

      {editing && (
        <AgentModal
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AgentModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: AgentDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [description, setDescription] = useState(agent?.description ?? '');
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [config, setConfig] = useState(agent?.config ?? EXAMPLES[0]!.config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = { name, description, enabled, config };
      if (agent) await api.updateAgent(agent.id, payload);
      else await api.createAgent(payload);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={agent ? `Edit ${agent.name}` : 'Add agent'}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={() => void save()} disabled={saving || !name || !config}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error && <Banner tone="critical">{error}</Banner>}

      <Field
        label="Name"
        hint="Becomes the key this agent appears under in --agents, and the name Claude delegates to by. Letters, digits, - and _."
      >
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="reviewer" />
      </Field>

      <Field label="Description" hint="What this agent is for. Shown when attaching it to a prompt.">
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Reviews a diff for correctness before it is pushed"
        />
      </Field>

      <Field
        label="Definition"
        hint={`A JSON object: { "description": "…", "prompt": "…" }, plus optional "tools" (an array, narrowing what it may use) and "model" (overriding the parent run's model for this agent alone).`}
      >
        <textarea value={config} onChange={(event) => setConfig(event.target.value)} style={{ minHeight: 190 }} />
      </Field>

      <div className="pill-list" style={{ marginBottom: 14 }}>
        {EXAMPLES.map((example) => (
          <button
            key={example.label}
            className="ghost small"
            type="button"
            onClick={() => {
              setConfig(example.config);
              if (!name) setName(example.name);
            }}
          >
            {example.label}
          </button>
        ))}
      </div>

      <Checkbox checked={enabled} onChange={setEnabled} label="Enabled" />
    </Modal>
  );
}
