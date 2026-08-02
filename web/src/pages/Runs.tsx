import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Card, Empty, StatusBadge } from '../components/primitives';
import { formatCost, formatDuration, formatRelative, formatTokens, triggerLabel } from '../format';
import { usePolled, useStream, useTicker } from '../hooks';
import type { Run, RunStatus } from '../types';

const FILTERS: Array<{ label: string; status?: RunStatus }> = [
  { label: 'All' },
  { label: 'Running', status: 'running' },
  { label: 'Queued', status: 'queued' },
  { label: 'Awaiting quota', status: 'rate_limited' },
  { label: 'Succeeded', status: 'succeeded' },
  { label: 'Failed', status: 'failed' },
];

/** Rows per page. The API caps a page at 500; this is what reads comfortably. */
const PAGE_SIZE = 100;

export function Runs() {
  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const [page, setPage] = useState(0);
  const now = useTicker(15_000);

  const { data, refresh } = usePolled<{ items: Run[]; total: number }>(
    () => api.runs({ status, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    15_000,
    [status, page],
  );

  const [cancelling, setCancelling] = useState<string | null>(null);

  /**
   * Stopping a run from the list rather than from inside it.
   *
   * A queued goal iteration is reachable nowhere else — it has no prompt page
   * and no chat — so without this the only way to stop one was to know its run
   * URL.
   */
  const cancel = async (id: string) => {
    setCancelling(id);
    await api.cancelRun(id).catch(() => undefined);
    setCancelling(null);
    refresh();
  };

  const choose = (next: RunStatus | undefined) => {
    setStatus(next);
    // Page 3 of "all" is not page 3 of "failed"; start the new filter at its top.
    setPage(0);
  };

  const total = data?.total ?? 0;
  const first = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const last = Math.min(total, (page + 1) * PAGE_SIZE);
  const hasMore = last < total;

  useStream((event) => {
    if (event === 'run:updated' || event === 'run:created') refresh();
  });

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Runs</h1>
          <p>Every execution, with what it cost and what it produced.</p>
        </div>
      </header>

      <nav className="tabs">
        {FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            className={`tab${status === filter.status ? ' active' : ''}`}
            onClick={() => choose(filter.status)}
          >
            {filter.label}
          </button>
        ))}
      </nav>

      <Card
        subtitle={
          data
            ? total > PAGE_SIZE
              ? `${first}–${last} of ${total} runs`
              : `${total} run${total === 1 ? '' : 's'}`
            : undefined
        }
      >
        {!data ? (
          <Empty>Loading…</Empty>
        ) : data.items.length === 0 ? (
          <Empty>No runs match this filter.</Empty>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Trigger</th>
                  <th>Started</th>
                  <th className="num">Duration</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link to={`/runs/${run.id}`}>{run.promptName}</Link>
                      {run.resumeOfRunId && <div className="stat-note">continues an earlier run</div>}
                    </td>
                    <td className="muted">{triggerLabel(run.triggerType)}</td>
                    <td className="muted" title={run.startedAt ?? run.queuedAt}>
                      {formatRelative(run.startedAt ?? run.queuedAt, now)}
                    </td>
                    <td className="num muted">{formatDuration(run.durationMs)}</td>
                    <td className="num">{formatTokens(run.totalTokens)}</td>
                    <td className="num muted">{formatCost(run.costUsd)}</td>
                    <td>
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="num">
                      {(run.status === 'queued' || run.status === 'running') && (
                        <button
                          className="ghost small"
                          disabled={cancelling === run.id}
                          onClick={() => void cancel(run.id)}
                        >
                          {run.status === 'queued' ? 'Cancel' : 'Stop'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data && total > PAGE_SIZE && (
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <span className="stat-note">
              Page {page + 1} of {Math.ceil(total / PAGE_SIZE)}
            </span>
            <button className="ghost small" disabled={page === 0} onClick={() => setPage((n) => n - 1)}>
              Newer
            </button>
            <button className="ghost small" disabled={!hasMore} onClick={() => setPage((n) => n + 1)}>
              Older
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
