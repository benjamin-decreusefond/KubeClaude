import { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Card, Checkbox, Empty, Field, Modal } from '../components/primitives';
import { usePolled } from '../hooks';
import type { McpServer } from '../types';

const EXAMPLES: Array<{ label: string; name: string; config: string }> = [
  {
    label: 'Remote SSE server',
    name: 'kubernetes',
    config: JSON.stringify(
      { type: 'sse', url: 'https://mcp-k8s.example.com/sse', headers: { Authorization: 'Basic ${MCP_K8S_AUTH}' } },
      null,
      2,
    ),
  },
  {
    label: 'Remote HTTP server',
    name: 'sentry',
    config: JSON.stringify(
      { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer ${SENTRY_TOKEN}' } },
      null,
      2,
    ),
  },
  {
    label: 'Local stdio command',
    name: 'linear',
    config: JSON.stringify(
      {
        command: 'npx',
        args: ['-y', 'mcp-remote', 'https://mcp.linear.app/sse'],
        env: { LINEAR_API_KEY: '${LINEAR_API_KEY}' },
      },
      null,
      2,
    ),
  },
];

export function McpServers() {
  const { data: servers, refresh } = usePolled<McpServer[]>(() => api.mcpServers(), 0);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>MCP connections</h1>
          <p>
            Connection details for MCP servers that run somewhere else. KubeClaude never starts or hosts a
            server — it writes these entries into the <code>.mcp.json</code> it hands to Claude.
          </p>
          <p style={{ marginTop: 8 }}>
            Reach for this when a service has no CLI. GitHub and Kubernetes already do:{' '}
            <code>gh</code> and <code>kubectl</code> ship in the image and authenticate from the environment
            and the pod's ServiceAccount, which is simpler than brokering the same APIs through a server that
            can be down.
          </p>
        </div>
        <button className="primary" onClick={() => setEditing('new')}>
          Add connection
        </button>
      </header>

      <Banner icon="i">
        Put secrets in the environment, not here. A <code>${'{VAR}'}</code> placeholder in the config is
        expanded from the run's environment, so a token set on the prompt — or forwarded from the pod —
        reaches the server without being stored in this database.
      </Banner>

      {servers?.length === 0 && (
        <Card>
          <Empty>No connections yet.</Empty>
        </Card>
      )}

      {servers?.map((server) => (
        <Card
          key={server.id}
          title={
            <span className="row">
              <code>{server.name}</code>
              {!server.enabled && <Badge>Disabled</Badge>}
            </span>
          }
          subtitle={server.description}
          actions={
            <>
              <button className="ghost small" onClick={() => setEditing(server)}>
                Edit
              </button>
              <button
                className="ghost small"
                onClick={async () => {
                  await api.updateMcpServer(server.id, { enabled: !server.enabled });
                  refresh();
                }}
              >
                {server.enabled ? 'Disable' : 'Enable'}
              </button>
              <button
                className="ghost small"
                onClick={async () => {
                  if (!confirm(`Remove the ${server.name} connection?`)) return;
                  await api.deleteMcpServer(server.id);
                  refresh();
                }}
              >
                ✕
              </button>
            </>
          }
        >
          <div className="mono-block">{server.config}</div>
        </Card>
      ))}

      {editing && (
        <McpModal
          server={editing === 'new' ? null : editing}
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

function McpModal({
  server,
  onClose,
  onSaved,
}: {
  server: McpServer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(server?.name ?? '');
  const [description, setDescription] = useState(server?.description ?? '');
  const [enabled, setEnabled] = useState(server?.enabled ?? true);
  const [config, setConfig] = useState(server?.config ?? EXAMPLES[0]!.config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = { name, description, enabled, config };
      if (server) await api.updateMcpServer(server.id, payload);
      else await api.createMcpServer(payload);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={server ? `Edit ${server.name}` : 'Add MCP connection'}
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
        hint="Becomes the key in .mcp.json and the prefix of its tool names (mcp__<name>__<tool>). Letters, digits, - and _."
      >
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} placeholder="github" />
      </Field>

      <Field label="Description" hint="What this connection is for. Shown when attaching it to a prompt.">
        <input
          type="text"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Read and merge pull requests"
        />
      </Field>

      <Field
        label="Configuration"
        hint="Either a bare server entry (wrapped under the name above) or a full { mcpServers: … } document."
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
