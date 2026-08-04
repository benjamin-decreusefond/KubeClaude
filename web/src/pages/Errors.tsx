import { useState } from 'react';
import { api } from '../api';
import { Badge, Banner, Card, Empty } from '../components/primitives';
import { formatDateTime, formatRelative } from '../format';
import { usePolled, useTicker } from '../hooks';
import type { AppError, DbBackup, ErrorSource } from '../types';

const SOURCE_LABEL: Record<ErrorSource, string> = {
  server: 'Server',
  browser: 'Browser',
  run: 'Run',
  notify: 'Notification',
};

const SOURCE_TONE: Record<ErrorSource, string> = {
  server: 'critical',
  browser: 'warning',
  run: 'warning',
  notify: 'warning',
};

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The list of things that went wrong where nobody was watching.
 *
 * A loop told to "improve the app and fix the bugs" needs somewhere to read what
 * the bugs actually are; so does a person after a deploy. Faults are folded by
 * identity and counted, so a poll that has been failing every fifteen seconds
 * since Tuesday is one line saying so, not four thousand.
 */
export function Errors() {
  const now = useTicker(20_000);
  const { data, refresh, loading } = usePolled<{ items: AppError[]; total: number }>(() => api.errors(), 20_000);
  const { data: backups } = usePolled<{ items: DbBackup[] }>(() => api.backups(), 0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const items = data?.items ?? [];

  const dismiss = async (id: string) => {
    setBusy(true);
    await api.dismissError(id).catch(() => undefined);
    setBusy(false);
    refresh();
  };

  const clearAll = async () => {
    setBusy(true);
    await api.clearErrors().catch(() => undefined);
    setBusy(false);
    refresh();
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Errors</h1>
          <p>
            Faults nothing else reports: a request that threw, a rejection nothing handled, a browser that
            failed to render, a run that could not be started at all. Identical faults are counted rather than
            repeated.
          </p>
        </div>
        {items.length > 0 && (
          <button className="ghost" disabled={busy} onClick={() => void clearAll()}>
            Clear all
          </button>
        )}
      </header>

      {!loading && items.length === 0 && (
        <Card>
          <Empty>Nothing has gone wrong since this list was last cleared.</Empty>
        </Card>
      )}

      {items.map((entry) => (
        <Card key={entry.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <Badge tone={SOURCE_TONE[entry.source]}>{SOURCE_LABEL[entry.source]}</Badge>
                {entry.count > 1 && <Badge>{entry.count}×</Badge>}
                {entry.context && <code>{entry.context}</code>}
              </div>
              <p style={{ marginTop: 8, wordBreak: 'break-word' }}>{entry.message}</p>
              <p className="stat-note">
                Last {formatRelative(entry.lastSeenAt, now)}
                {entry.count > 1 && ` · first ${formatDateTime(entry.firstSeenAt)}`}
              </p>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {entry.detail && (
                <button
                  className="ghost small"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                >
                  {expanded === entry.id ? 'Hide' : 'Stack'}
                </button>
              )}
              <button className="ghost small" disabled={busy} onClick={() => void dismiss(entry.id)}>
                Dismiss
              </button>
            </div>
          </div>

          {expanded === entry.id && entry.detail && (
            <pre className="log-body" style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
              {entry.detail}
            </pre>
          )}
        </Card>
      ))}

      <Card
        title="Database backups"
        subtitle="A copy is taken before any migration runs, because a migration that breaks startup is the one failure this app cannot fix from inside itself"
      >
        {backups?.items.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>File</th>
                <th>Taken</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {backups.items.map((backup) => (
                <tr key={backup.file}>
                  <td>
                    <code>{backup.file}</code>
                  </td>
                  <td>{formatDateTime(backup.takenAt)}</td>
                  <td>{bytesLabel(backup.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>No backups yet — the schema has not changed since this instance was created.</Empty>
        )}
        <Banner icon="i">
          Restoring one is a deliberate act, not something the app does to itself while running on top of the
          file: stop the pod, copy the backup over <code>kubeclaude.db</code>, start it again.
        </Banner>
      </Card>
    </div>
  );
}
