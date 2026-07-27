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
  { label: 'Awaiting quota', status: 'rate_limited' },
  { label: 'Succeeded', status: 'succeeded' },
  { label: 'Failed', status: 'failed' },
];

export function Runs() {
  const [status, setStatus] = useState<RunStatus | undefined>(undefined);
  const now = useTicker(15_000);

  const { data, refresh } = usePolled<{ items: Run[]; total: number }>(
    () => api.runs({ status, limit: 100 }),
    15_000,
    [status],
  );

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
            onClick={() => setStatus(filter.status)}
          >
            {filter.label}
          </button>
        ))}
      </nav>

      <Card subtitle={data ? `${data.total} run${data.total === 1 ? '' : 's'}` : undefined}>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
