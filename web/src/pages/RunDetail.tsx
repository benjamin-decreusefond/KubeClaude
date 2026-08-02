import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { RunLog } from '../components/RunLog';
import { Badge, Banner, Card, Checkbox, Empty, StatusBadge } from '../components/primitives';
import {
  formatCost,
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
  formatTokens,
  triggerLabel,
} from '../format';
import { useStream, useTicker } from '../hooks';
import type { Run, RunEvent } from '../types';

/**
 * How much live output the page keeps. The server trims its own history, and a
 * browser holding every line of a long run gets slow long before it runs out of
 * memory — reloading the page fetches whatever the server still has.
 */
const LIVE_EVENT_LIMIT = 2_000;

/** How far back to look for a duplicate; frames arrive in order, give or take. */
const LIVE_EVENT_WINDOW = 50;

export function RunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const now = useTicker(10_000);

  const [run, setRun] = useState<Run | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [thread, setThread] = useState<Run[]>([]);
  const [follow, setFollow] = useState(true);
  const [followUp, setFollowUp] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const [fetched, eventPage, threadPage] = await Promise.all([
      api.run(id),
      api.runEvents(id),
      api.runThread(id),
    ]);
    setRun(fetched);
    setEvents(eventPage.events);
    setThread(threadPage.runs);
  }, [id]);

  useEffect(() => {
    setEvents([]);
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  // Live output for this run; a status change also refreshes the thread.
  useStream(
    (event, payload) => {
      if (event === 'run:event') {
        const runEvent = payload as RunEvent;
        if (runEvent.runId !== id) return;
        setEvents((current) => {
          // A run can emit thousands of lines. Scanning the whole list for a
          // duplicate on every one of them is quadratic, and the tail is the
          // only part anybody reads — so check the tail and keep the tail.
          const recent = current.slice(-LIVE_EVENT_WINDOW);
          if (recent.some((existing) => existing.seq === runEvent.seq)) return current;
          const next = [...current, runEvent];
          return next.length > LIVE_EVENT_LIMIT ? next.slice(-LIVE_EVENT_LIMIT) : next;
        });
      } else if (event === 'run:updated') {
        const updated = payload as Run;
        if (updated.id === id) setRun(updated);
        if (updated.rootRunId === run?.rootRunId) void load();
      } else if (event === 'run:created') {
        const created = payload as Run;
        if (created.rootRunId === run?.rootRunId) void load();
      }
    },
    id,
  );

  const active = run?.status === 'running' || run?.status === 'queued';

  const act = async (action: () => Promise<Run | void>, note: string) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setMessage(note);
      if (result && 'id' in result && result.id !== id) navigate(`/runs/${result.id}`);
      else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const tokenRows = useMemo(() => {
    if (!run) return [];
    return [
      { label: 'Input', value: run.inputTokens },
      { label: 'Output', value: run.outputTokens },
      { label: 'Cache write', value: run.cacheCreationTokens },
      { label: 'Cache read', value: run.cacheReadTokens },
    ];
  }, [run]);

  if (!run) {
    return (
      <div>
        <h1>Run</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          {error ?? 'Loading…'}
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <div className="row">
            <h1>{run.promptName}</h1>
            <StatusBadge status={run.status} />
            {run.resumeAttempt > 0 && <Badge>Resume #{run.resumeAttempt}</Badge>}
          </div>
          <p>
            {triggerLabel(run.triggerType)} · queued {formatDateTime(run.queuedAt)}
            {run.model ? ` · ${run.model}` : ''}
          </p>
        </div>
        <div className="row">
          <Link to={`/prompts/${run.promptId}`}>
            <button className="ghost">Open prompt</button>
          </Link>
          {active && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void act(() => api.cancelRun(run.id), 'Cancelling')}
            >
              Cancel
            </button>
          )}
          {run.status === 'rate_limited' && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void act(() => api.resumeRun(run.id), 'Resuming now')}
            >
              Resume now
            </button>
          )}
        </div>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      {run.status === 'rate_limited' && (
        <Banner tone="warning">
          <strong>{run.error ?? 'The Claude quota ran out.'}</strong>
          <div className="stat-note" style={{ marginTop: 4 }}>
            {run.completionReason ? `${run.completionReason}. ` : ''}
            {run.autoResumePending
              ? `KubeClaude will continue this session automatically${
                  run.rateLimitResetAt ? ` around ${formatDateTime(run.rateLimitResetAt)}` : ' once tokens return'
                }.`
              : run.completed
                ? 'No resume is scheduled: the task had already been carried to the end.'
                : 'No automatic resume is scheduled. Use “Resume now” to continue it by hand.'}
          </div>
        </Banner>
      )}

      {run.status === 'failed' && run.error && (
        <Banner tone="critical">
          <strong>Run failed</strong>
          <div className="stat-note" style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>
            {run.error}
          </div>
        </Banner>
      )}

      <div className="grid-3">
        <Card>
          <div className="stat">
            <div className="stat-label">Tokens</div>
            <div className="stat-value">{formatTokens(run.totalTokens)}</div>
            <div className="stat-note">
              {tokenRows.map((row) => `${row.label} ${formatTokens(row.value)}`).join(' · ')}
            </div>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <div className="stat-label">Cost</div>
            <div className="stat-value">{formatCost(run.costUsd)}</div>
            <div className="stat-note">
              {run.numTurns !== null ? `${formatNumber(run.numTurns)} turns` : '—'}
              {run.serviceTier ? ` · ${run.serviceTier} tier` : ''}
            </div>
          </div>
        </Card>
        <Card>
          <div className="stat">
            <div className="stat-label">Duration</div>
            <div className="stat-value">{formatDuration(run.durationMs)}</div>
            <div className="stat-note">
              {run.durationApiMs !== null ? `${formatDuration(run.durationApiMs)} in Claude` : '—'}
            </div>
          </div>
        </Card>
      </div>

      {thread.length > 1 && (
        <Card
          title="Conversation"
          subtitle="Resumes and follow-ups share one Claude session, so context carries across them"
        >
          {thread.map((item) => (
            <div className={`thread-item${item.id === run.id ? ' current' : ''}`} key={item.id}>
              <div className="thread-rail" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row">
                  {item.id === run.id ? (
                    <strong>{triggerLabel(item.triggerType)}</strong>
                  ) : (
                    <Link to={`/runs/${item.id}`}>{triggerLabel(item.triggerType)}</Link>
                  )}
                  <StatusBadge status={item.status} />
                  <span className="stat-note">{formatRelative(item.queuedAt, now)}</span>
                  <span className="stat-note" style={{ marginLeft: 'auto' }}>
                    {formatTokens(item.totalTokens)} tokens
                  </span>
                </div>
                <p className="stat-note" style={{ whiteSpace: 'pre-wrap', marginTop: 2 }}>
                  {(item.followUpText ?? item.promptText).slice(0, 220)}
                  {(item.followUpText ?? item.promptText).length > 220 ? '…' : ''}
                </p>
              </div>
            </div>
          ))}
        </Card>
      )}

      <Card
        title="Output"
        subtitle={active ? 'Streaming live' : `${events.length} events`}
        actions={
          <>
            <Checkbox checked={follow} onChange={setFollow} label="Follow" />
            {active && <span className="spinner" aria-label="running" />}
          </>
        }
      >
        <RunLog events={events} follow={follow && active} />
      </Card>

      {run.resultText && (
        <Card title="Final message">
          <div className="mono-block">{run.resultText}</div>
        </Card>
      )}

      {run.sessionId && !active && (
        <Card
          title="Follow up"
          subtitle="Continue this same Claude session with another instruction — it keeps everything from this run"
        >
          <textarea
            value={followUp}
            onChange={(event) => setFollowUp(event.target.value)}
            placeholder="Also open a PR with the changes and link it here."
            style={{ minHeight: 84 }}
          />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              className="primary"
              disabled={busy || followUp.trim().length === 0}
              onClick={() =>
                void act(async () => {
                  const created = await api.followUp(run.id, followUp.trim());
                  setFollowUp('');
                  return created;
                }, 'Follow-up queued')
              }
            >
              Send follow-up
            </button>
          </div>
        </Card>
      )}

      <Card title="Details">
        <dl className="kv">
          <dt>Run id</dt>
          <dd>
            <code>{run.id}</code>
          </dd>
          <dt>Claude session</dt>
          <dd>{run.sessionId ? <code>{run.sessionId}</code> : '—'}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(run.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{formatDateTime(run.finishedAt)}</dd>
          <dt>Exit code</dt>
          <dd>{run.exitCode ?? '—'}</dd>
          {run.modelUsage && (
            <>
              <dt>Per model</dt>
              <dd>
                {Object.entries(run.modelUsage).map(([model, usage]) => (
                  <div key={model}>
                    <code>{model}</code> — in {formatTokens(usage.inputTokens)}, out{' '}
                    {formatTokens(usage.outputTokens)}, {formatCost(usage.costUsd)}
                  </div>
                ))}
              </dd>
            </>
          )}
          <dt>Prompt sent</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{run.promptText}</dd>
        </dl>
      </Card>

      {events.length === 0 && !active && <Empty>This run produced no recorded output.</Empty>}

      {message && (
        <div className="toast" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}
