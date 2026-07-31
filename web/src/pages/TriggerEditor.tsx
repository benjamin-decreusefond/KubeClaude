import { useEffect, useState } from 'react';
import { api } from '../api';
import { Badge, Card, Empty, Field, Modal } from '../components/primitives';
import { formatDateTime, formatRelative, triggerLabel } from '../format';
import type { Trigger, TriggerConfig, TriggerType } from '../types';

const TRIGGER_HELP: Record<TriggerType, string> = {
  cron: 'Runs on a cron schedule. After downtime it catches up once, not once per missed slot.',
  interval: 'Runs every N minutes, measured from the last fire.',
  session_reset:
    'Runs once per rolling 5-hour Claude window: immediately when no window is open, then again as soon as the window rolls over. This is the "run as soon as I have tokens again" trigger.',
  weekly_reset: 'Runs once per weekly window, as soon as the week rolls over.',
  quota_available:
    'Runs when a configured share of the token budget is free again. Needs a token budget in Settings; without one it behaves like the 5-hour trigger.',
};

const CRON_PRESETS: Array<{ label: string; expression: string }> = [
  { label: 'Every hour', expression: '0 * * * *' },
  { label: 'Every day at 09:00', expression: '0 9 * * *' },
  { label: 'Weekdays at 08:30', expression: '30 8 * * 1-5' },
  { label: 'Every Monday at 07:00', expression: '0 7 * * 1' },
];

export function TriggerList({
  promptId,
  triggers,
  timezone,
  onChange,
}: {
  promptId: string;
  triggers: Trigger[];
  timezone: string;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Trigger | 'new' | null>(null);

  return (
    <Card
      title="Triggers"
      subtitle="When this prompt runs on its own"
      actions={
        <button className="small" type="button" onClick={() => setEditing('new')}>
          Add trigger
        </button>
      }
    >
      {triggers.length === 0 ? (
        <Empty>No triggers. This prompt only runs when you press “Run now”.</Empty>
      ) : (
        <table className="table">
          <tbody>
            {triggers.map((trigger) => (
              <tr key={trigger.id}>
                <td>
                  <div className="row">
                    <strong>{triggerLabel(trigger.type)}</strong>
                    {!trigger.enabled && <Badge>Paused</Badge>}
                  </div>
                  <div className="stat-note">{describe(trigger)}</div>
                </td>
                <td className="num muted">
                  {trigger.nextFireAt ? (
                    <span title={formatDateTime(trigger.nextFireAt)}>
                      {formatRelative(trigger.nextFireAt)}
                    </span>
                  ) : (
                    'next tick'
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="ghost small" type="button" onClick={() => setEditing(trigger)}>
                    Edit
                  </button>
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() =>
                      void api.updateTrigger(trigger.id, { enabled: !trigger.enabled }).then(onChange)
                    }
                  >
                    {trigger.enabled ? 'Pause' : 'Resume'}
                  </button>
                  <button
                    className="ghost small"
                    type="button"
                    onClick={() => void api.deleteTrigger(trigger.id).then(onChange)}
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <TriggerModal
          promptId={promptId}
          trigger={editing === 'new' ? null : editing}
          timezone={timezone}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}
    </Card>
  );
}

function describe(trigger: Trigger): string {
  switch (trigger.type) {
    case 'cron':
      return `${trigger.cronExpression} (${trigger.timezone})`;
    case 'interval':
      return `Every ${trigger.config.intervalMinutes ?? '?'} minutes`;
    case 'session_reset':
      return trigger.config.delayMinutes
        ? `${trigger.config.delayMinutes} min after each 5h window opens`
        : 'As soon as each 5h window opens';
    case 'weekly_reset':
      return 'As soon as each weekly window opens';
    case 'quota_available': {
      const parts: string[] = [];
      if (trigger.config.minSessionPctAvailable !== undefined) {
        parts.push(`${trigger.config.minSessionPctAvailable}% of the 5h budget free`);
      }
      if (trigger.config.minSessionTokensAvailable !== undefined) {
        parts.push(`${trigger.config.minSessionTokensAvailable} tokens free`);
      }
      if (trigger.config.minWeeklyPctAvailable !== undefined) {
        parts.push(`${trigger.config.minWeeklyPctAvailable}% of the weekly budget free`);
      }
      return parts.length > 0 ? `When ${parts.join(' and ')}` : 'When tokens are available';
    }
    default:
      return '';
  }
}

function TriggerModal({
  promptId,
  trigger,
  timezone,
  onClose,
  onSaved,
}: {
  promptId: string;
  trigger: Trigger | null;
  timezone: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [type, setType] = useState<TriggerType>(trigger?.type ?? 'session_reset');
  const [cronExpression, setCronExpression] = useState(trigger?.cronExpression ?? '0 9 * * *');
  const [tz, setTz] = useState(trigger?.timezone ?? timezone);
  const [config, setConfig] = useState<TriggerConfig>(trigger?.config ?? {});
  const [preview, setPreview] = useState<{ valid: boolean; next: string[]; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (type !== 'cron' || !cronExpression.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewCron(cronExpression, tz)
        .then((result) => !cancelled && setPreview(result))
        .catch(() => !cancelled && setPreview(null));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [type, cronExpression, tz]);

  const patch = (next: Partial<TriggerConfig>) => setConfig((current) => ({ ...current, ...next }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        type,
        enabled: trigger?.enabled ?? true,
        cronExpression: type === 'cron' ? cronExpression : null,
        timezone: tz,
        config,
      };
      if (trigger) await api.updateTrigger(trigger.id, payload);
      else await api.createTrigger(promptId, payload);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={trigger ? 'Edit trigger' : 'Add trigger'}
      onClose={onClose}
      footer={
        <>
          <button className="ghost" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="button" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save trigger'}
          </button>
        </>
      }
    >
      {error && <div className="banner critical">{error}</div>}

      <Field label="Trigger type" hint={TRIGGER_HELP[type]}>
        <select value={type} onChange={(event) => setType(event.target.value as TriggerType)}>
          <option value="session_reset">When a new 5-hour session opens</option>
          <option value="quota_available">When enough tokens are free</option>
          <option value="weekly_reset">When a new week opens</option>
          <option value="cron">On a cron schedule</option>
          <option value="interval">Every N minutes</option>
        </select>
      </Field>

      {type === 'cron' && (
        <>
          <Field label="Cron expression" hint="Five fields: minute hour day-of-month month day-of-week.">
            <input
              type="text"
              value={cronExpression}
              onChange={(event) => setCronExpression(event.target.value)}
            />
          </Field>
          <div className="pill-list" style={{ marginBottom: 14 }}>
            {CRON_PRESETS.map((preset) => (
              <button
                key={preset.expression}
                type="button"
                className="ghost small"
                onClick={() => setCronExpression(preset.expression)}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <Field label="Timezone" hint="An IANA name such as Europe/Paris.">
            <input type="text" value={tz} onChange={(event) => setTz(event.target.value)} />
          </Field>
          {preview && (
            <div className="banner" style={{ marginBottom: 14 }}>
              {preview.valid ? (
                <div>
                  <strong>Next runs</strong>
                  <div className="stat-note">
                    {preview.next.map((iso) => formatDateTime(iso)).join(' · ') || 'never'}
                  </div>
                </div>
              ) : (
                <div className="critical">Invalid expression: {preview.error}</div>
              )}
            </div>
          )}
        </>
      )}

      {type === 'interval' && (
        <Field label="Every (minutes)">
          <input
            type="number"
            min={1}
            value={config.intervalMinutes ?? 60}
            onChange={(event) => patch({ intervalMinutes: Number(event.target.value) })}
          />
        </Field>
      )}

      {(type === 'session_reset' || type === 'weekly_reset') && (
        <Field
          label="Delay after the window opens (minutes)"
          hint="Useful when several prompts should not all start at the same instant."
        >
          <input
            type="number"
            min={0}
            value={config.delayMinutes ?? 0}
            onChange={(event) => patch({ delayMinutes: Number(event.target.value) })}
          />
        </Field>
      )}

      {type === 'quota_available' && (
        <>
          <Field label="Minimum share of the 5h budget free (%)">
            <input
              type="number"
              min={0}
              max={100}
              value={config.minSessionPctAvailable ?? 50}
              onChange={(event) => patch({ minSessionPctAvailable: Number(event.target.value) })}
            />
          </Field>
          <Field label="Minimum share of the weekly budget free (%)" hint="Leave at 0 to ignore the week.">
            <input
              type="number"
              min={0}
              max={100}
              value={config.minWeeklyPctAvailable ?? 0}
              onChange={(event) => patch({ minWeeklyPctAvailable: Number(event.target.value) })}
            />
          </Field>
        </>
      )}

      <Field
        label="Never fire more often than (minutes)"
        hint="A floor applied on top of the rule above. 0 means no floor."
      >
        <input
          type="number"
          min={0}
          value={config.minIntervalMinutes ?? 0}
          onChange={(event) => patch({ minIntervalMinutes: Number(event.target.value) })}
        />
      </Field>
    </Modal>
  );
}
