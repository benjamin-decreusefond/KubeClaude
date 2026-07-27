import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge, Banner, Card, Empty, Field, StatusBadge } from '../components/primitives';
import { formatRelative, formatTokens } from '../format';
import { usePolled, useTicker } from '../hooks';
import type { ChatSummary, McpServer, ModelOption, PermissionMode, Prompt } from '../types';

export function Chats() {
  const navigate = useNavigate();
  const now = useTicker(20_000);

  const { data: chats, refresh } = usePolled<ChatSummary[]>(() => api.chats(), 15_000);
  const { data: modelData } = usePolled<{ models: ModelOption[] }>(() => api.models(), 0);
  const { data: mcpServers } = usePolled<McpServer[]>(() => api.mcpServers(), 0);
  const { data: prompts } = usePolled<Prompt[]>(() => api.prompts(), 0);

  const [message, setMessage] = useState('');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [workingDir, setWorkingDir] = useState('');
  const [fromPromptId, setFromPromptId] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (!message.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const chat = await api.startChat({
        message: message.trim(),
        model: model || null,
        permissionMode,
        mcpServerIds,
        workingDir: workingDir || null,
        fromPromptId: fromPromptId || undefined,
      });
      navigate(`/chats/${chat.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Chat</h1>
          <p>
            Talk to Claude directly, with the same access a scheduled prompt gets. It keeps the session
            between messages, so you can steer it as it works — and save the result as a prompt once it does
            what you want.
          </p>
        </div>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      <Card>
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void start();
          }}
          placeholder={
            'Check whether the media namespace is healthy, and tell me what changed since yesterday.\n\n' +
            'Or: review the open PRs on kubernetes and merge anything green that only touches dependencies.'
          }
          style={{ minHeight: 120 }}
        />

        <div className="row" style={{ marginTop: 10, justifyContent: 'space-between' }}>
          <div className="row">
            <select value={model} onChange={(event) => setModel(event.target.value)} style={{ width: 'auto' }}>
              {(modelData?.models ?? []).map((option) => (
                <option key={option.id || 'default'} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <button className="ghost small" onClick={() => setAdvanced((value) => !value)}>
              {advanced ? 'Fewer options' : 'More options'}
            </button>
          </div>
          <button className="primary" disabled={starting || !message.trim()} onClick={() => void start()}>
            {starting ? 'Starting…' : 'Start chat'}
          </button>
        </div>

        {advanced && (
          <div style={{ marginTop: 16, borderTop: '1px solid var(--grid)', paddingTop: 14 }}>
            <Field
              label="Start from an existing prompt"
              hint="Copies its model, tools, MCP connections and workspace, so you can try it out before scheduling it."
            >
              <select value={fromPromptId} onChange={(event) => setFromPromptId(event.target.value)}>
                <option value="">Nothing — start clean</option>
                {(prompts ?? []).map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Permission mode"
              hint={
                permissionMode === 'bypassPermissions'
                  ? 'Tools run without asking. You are watching in real time, which is the point of a chat — but it can change files, push commits and merge PRs.'
                  : permissionMode === 'default'
                    ? 'Anything needing approval is denied, since a headless run has nobody to ask. Good for read-only questions; a task that must write will stall.'
                    : permissionMode === 'plan'
                      ? 'Research and propose only, no changes.'
                      : 'File edits auto-approved; other tools still need permission.'
              }
            >
              <select
                value={permissionMode}
                onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
              >
                <option value="bypassPermissions">bypassPermissions — let it act</option>
                <option value="acceptEdits">acceptEdits — auto-approve file edits</option>
                <option value="plan">plan — research only</option>
                <option value="default">default — deny anything needing approval</option>
              </select>
            </Field>

            <Field label="Working directory" hint="Leave empty for a fresh managed workspace.">
              <input
                type="text"
                value={workingDir}
                onChange={(event) => setWorkingDir(event.target.value)}
                placeholder="/data/workspaces/kubernetes"
              />
            </Field>

            {(mcpServers ?? []).length > 0 && (
              <Field label="MCP connections">
                <div className="pill-list">
                  {(mcpServers ?? []).map((server) => {
                    const on = mcpServerIds.includes(server.id);
                    return (
                      <button
                        key={server.id}
                        type="button"
                        className={on ? 'small' : 'ghost small'}
                        onClick={() =>
                          setMcpServerIds((current) =>
                            on ? current.filter((value) => value !== server.id) : [...current, server.id],
                          )
                        }
                      >
                        {on ? '✓ ' : ''}
                        {server.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            )}
          </div>
        )}
      </Card>

      <Card title="Conversations" actions={<button className="ghost small" onClick={refresh}>Refresh</button>}>
        {!chats ? (
          <Empty>Loading…</Empty>
        ) : chats.length === 0 ? (
          <Empty>No conversations yet. Say something above to start one.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {chats.map((chat) => (
                <tr key={chat.id} className="clickable" onClick={() => navigate(`/chats/${chat.id}`)}>
                  <td>
                    <Link to={`/chats/${chat.id}`}>{chat.title}</Link>
                    <div className="stat-note">
                      {chat.messageCount} message{chat.messageCount === 1 ? '' : 's'} ·{' '}
                      {formatRelative(chat.updatedAt, now)}
                      {chat.model ? ` · ${chat.model}` : ''}
                    </div>
                  </td>
                  <td className="num muted">
                    {chat.lastRun ? formatTokens(chat.lastRun.totalTokens) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {chat.lastRun && <StatusBadge status={chat.lastRun.status} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
