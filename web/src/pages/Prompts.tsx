import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, describeError } from '../api';
import { Badge, Card, Empty, StatusBadge } from '../components/primitives';
import { formatRelative, formatTokens, triggerLabel } from '../format';
import { usePolled, useStream, useTicker } from '../hooks';
import type { Prompt } from '../types';

export function Prompts() {
  const { data: prompts, refresh, loading } = usePolled<Prompt[]>(() => api.prompts(), 20_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const navigate = useNavigate();
  const now = useTicker(15_000);

  useStream((event) => {
    if (event === 'run:updated' || event === 'run:created') refresh();
  });

  const runNow = async (prompt: Prompt) => {
    setBusy(prompt.id);
    try {
      const run = await api.runPrompt(prompt.id);
      navigate(`/runs/${run.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async (prompt: Prompt) => {
    await api.updatePrompt(prompt.id, { enabled: !prompt.enabled });
    refresh();
  };

  const fileInput = useRef<HTMLInputElement>(null);

  const importPrompt = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as Partial<Prompt>;
      const created = await api.createPrompt(parsed);
      refresh();
      navigate(`/prompts/${created.id}`);
    } catch (error) {
      setMessage(describeError(error));
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Prompts</h1>
          <p>
            Each prompt is a task Claude runs on its own: the instructions, the model, what it is allowed to
            touch, and when it should fire.
          </p>
        </div>
        <div className="row">
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) void importPrompt(file);
            }}
          />
          <button type="button" onClick={() => fileInput.current?.click()}>
            Import
          </button>
          <Link to="/prompts/new">
            <button className="primary">New prompt</button>
          </Link>
        </div>
      </header>

      {loading && !prompts && <Card>Loading…</Card>}

      {prompts?.length === 0 && (
        <Card>
          <Empty>
            No prompts yet. <Link to="/prompts/new">Create the first one</Link> — give it a task, pick a
            model, and add a trigger.
          </Empty>
        </Card>
      )}

      {prompts?.map((prompt) => (
        <Card key={prompt.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row">
                <Link to={`/prompts/${prompt.id}`}>
                  <h2>{prompt.name}</h2>
                </Link>
                {!prompt.enabled && <Badge>Disabled</Badge>}
                {prompt.model && <Badge>{prompt.model}</Badge>}
                {prompt.autoResume && <Badge>Auto-resume</Badge>}
                {prompt.mcpServerIds.length > 0 && (
                  <Badge>
                    {prompt.mcpServerIds.length} MCP{prompt.mcpServerIds.length === 1 ? '' : 's'}
                  </Badge>
                )}
              </div>
              {prompt.description && (
                <p className="secondary" style={{ marginTop: 6 }}>
                  {prompt.description}
                </p>
              )}
              <p className="stat-note" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {prompt.prompt.slice(0, 180)}
                {prompt.prompt.length > 180 ? '…' : ''}
              </p>
            </div>

            <div className="row">
              <button className="small" disabled={busy === prompt.id} onClick={() => void runNow(prompt)}>
                {busy === prompt.id ? 'Queuing…' : 'Run now'}
              </button>
              <button className="ghost small" onClick={() => void toggle(prompt)}>
                {prompt.enabled ? 'Disable' : 'Enable'}
              </button>
              <Link to={`/prompts/${prompt.id}`}>
                <button className="ghost small">Edit</button>
              </Link>
            </div>
          </div>

          <div
            className="row"
            style={{ marginTop: 12, gap: 16, borderTop: '1px solid var(--grid)', paddingTop: 10 }}
          >
            <div className="stat-note">
              {prompt.triggers && prompt.triggers.length > 0 ? (
                <>
                  {prompt.triggers.map((trigger) => (
                    <span key={trigger.id} style={{ marginRight: 10 }}>
                      {triggerLabel(trigger.type)}
                      {trigger.cronExpression ? ` (${trigger.cronExpression})` : ''}
                      {trigger.nextFireAt ? ` — ${formatRelative(trigger.nextFireAt, now)}` : ''}
                      {!trigger.enabled ? ' — paused' : ''}
                    </span>
                  ))}
                </>
              ) : (
                <span>No triggers — runs only when you ask</span>
              )}
            </div>

            {prompt.lastRun && (
              <div className="row" style={{ marginLeft: 'auto' }}>
                <span className="stat-note">
                  Last run {formatRelative(prompt.lastRun.queuedAt, now)} ·{' '}
                  {formatTokens(prompt.lastRun.totalTokens)} tokens
                </span>
                <Link to={`/runs/${prompt.lastRun.id}`}>
                  <StatusBadge status={prompt.lastRun.status} />
                </Link>
              </div>
            )}
          </div>
        </Card>
      ))}

      {message && (
        <div className="toast error" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}
