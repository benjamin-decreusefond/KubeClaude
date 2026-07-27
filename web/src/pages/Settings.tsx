import { useEffect, useState } from 'react';
import { api } from '../api';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { Badge, Banner, Card, Checkbox, Field } from '../components/primitives';
import { formatTokens } from '../format';
import { usePolled } from '../hooks';
import type { Capabilities, ModelOption, Settings, Status } from '../types';

export function SettingsPage() {
  const { data: loaded, refresh } = usePolled<Settings>(() => api.settings(), 0);
  const { data: status } = usePolled<Status>(() => api.status(), 20_000);
  const { data: capabilities } = usePolled<Capabilities>(() => api.capabilities(), 0);
  const { data: modelData } = usePolled<{ models: ModelOption[] }>(() => api.models(), 0);
  const { data: defaults } = usePolled<Settings>(() => api.settingsDefaults(), 0);

  const [draft, setDraft] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loaded) setDraft(loaded);
  }, [loaded]);

  if (!draft) return <div>Loading…</div>;

  const patch = (next: Partial<Settings>) => setDraft({ ...draft, ...next });

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.updateSettings(draft);
      refresh();
      setMessage('Settings saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Defaults for every prompt, and how KubeClaude accounts for your Claude quota.</p>
        </div>
        <button className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      <Card title="Claude access" subtitle="Credentials come from the pod environment, never from this page">
        {status?.credentialsConfigured ? (
          <p className="secondary">
            Authenticated with{' '}
            {capabilities?.credentials.variables.map((name) => (
              <code key={name} style={{ marginRight: 6 }}>
                {name}
              </code>
            ))}
            .
          </p>
        ) : (
          <Banner tone="critical">
            No credentials. Set <code>CLAUDE_CODE_OAUTH_TOKEN</code> for a Claude subscription — that is what
            makes the 5-hour and weekly windows below meaningful — or <code>ANTHROPIC_API_KEY</code> for API
            billing, then restart the pod.
          </Banner>
        )}

        <div className="pill-list" style={{ marginTop: 12 }}>
          {capabilities?.tools.map((tool) => (
            <Badge key={tool.name} tone={tool.available ? 'good' : undefined}>
              <span className="badge-dot" />
              {tool.name}
              {tool.available ? '' : ' missing'}
            </Badge>
          ))}
        </div>
        <p className="stat-note" style={{ marginTop: 8 }}>
          Claude CLI {status?.claudeVersion ?? 'not detected'} · up to {status?.maxConcurrentRuns ?? 1}{' '}
          concurrent run{status?.maxConcurrentRuns === 1 ? '' : 's'}.
        </p>
      </Card>

      <Card title="Defaults">
        <Field label="Default model" hint="Used by any prompt that does not pin its own.">
          <select
            value={draft.defaultModel ?? ''}
            onChange={(event) => patch({ defaultModel: event.target.value || null })}
          >
            {(modelData?.models ?? []).map((model) => (
              <option key={model.id || 'default'} value={model.id}>
                {model.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Timezone" hint="Used for new cron triggers. An IANA name such as Europe/Paris.">
          <input type="text" value={draft.timezone} onChange={(event) => patch({ timezone: event.target.value })} />
        </Field>

        <Field
          label="Global environment"
          hint="Merged into every run before the prompt's own env. Handy for a shared GITHUB_TOKEN or GIT_AUTHOR_NAME."
        >
          <KeyValueEditor value={draft.globalEnv} onChange={(globalEnv) => patch({ globalEnv })} />
        </Field>
      </Card>

      <Card
        title="Environment briefing"
        subtitle="What every run is told before its own instructions"
      >
        <p className="secondary" style={{ marginBottom: 12 }}>
          A scheduled run starts with no history and nobody to ask, so anything it needs to know about this
          platform has to be stated up front: that it has a cluster to inspect, a GitHub token to push and
          merge with, and that changes reach the cluster through git rather than <code>kubectl</code>. This
          text goes into every run's system prompt, ahead of the prompt itself. Prompt-specific detail
          belongs on the prompt, not here.
        </p>
        <Field label="Briefing" hint="Markdown. Leave empty to send nothing.">
          <textarea
            value={draft.environmentBriefing}
            onChange={(event) => patch({ environmentBriefing: event.target.value })}
            style={{ minHeight: 320 }}
          />
        </Field>
        <div className="row">
          <button
            type="button"
            className="ghost small"
            disabled={!defaults}
            onClick={() => defaults && patch({ environmentBriefing: defaults.environmentBriefing })}
          >
            Restore the default briefing
          </button>
          <span className="stat-note">
            {draft.environmentBriefing.length.toLocaleString()} characters, sent on every run
          </span>
        </div>
      </Card>

      <Card
        title="Quota windows"
        subtitle="How KubeClaude models the Claude allowance, so quota-aware triggers and the gauges on the overview mean something"
      >
        <div className="grid-2">
          <Field label="Session window (hours)" hint="Claude's rolling session window. 5 by default.">
            <input
              type="number"
              min={0.5}
              step={0.5}
              value={draft.sessionWindowHours}
              onChange={(event) => patch({ sessionWindowHours: Number(event.target.value) })}
            />
          </Field>
          <Field label="Weekly window (days)">
            <input
              type="number"
              min={1}
              value={draft.weeklyWindowDays}
              onChange={(event) => patch({ weeklyWindowDays: Number(event.target.value) })}
            />
          </Field>
        </div>

        <div className="grid-2">
          <Field
            label="Session token budget"
            hint={
              draft.sessionTokenBudget > 0
                ? `${formatTokens(draft.sessionTokenBudget)} tokens per 5h window.`
                : 'Unset — the overview shows totals instead of a gauge, and quota triggers fall back to firing once per window. Anthropic does not publish an exact number, so set this from what you observe.'
            }
          >
            <input
              type="number"
              min={0}
              step={100000}
              value={draft.sessionTokenBudget}
              onChange={(event) => patch({ sessionTokenBudget: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Weekly token budget"
            hint={draft.weeklyTokenBudget > 0 ? `${formatTokens(draft.weeklyTokenBudget)} tokens per week.` : 'Unset.'}
          >
            <input
              type="number"
              min={0}
              step={1000000}
              value={draft.weeklyTokenBudget}
              onChange={(event) => patch({ weeklyTokenBudget: Number(event.target.value) })}
            />
          </Field>
        </div>

        <Checkbox
          checked={draft.quotaGuardEnabled}
          onChange={(quotaGuardEnabled) => patch({ quotaGuardEnabled })}
          label="Hold runs back once a budget is spent"
          hint="Held runs are parked and resumed when the window rolls over, rather than failing. Needs a budget above."
        />

        <Field
          label="Keep in reserve (%)"
          hint="Share of each budget the guard refuses to spend, so an interactive session still has room."
        >
          <input
            type="number"
            min={0}
            max={90}
            value={draft.quotaReservePct}
            onChange={(event) => patch({ quotaReservePct: Number(event.target.value) })}
          />
        </Field>
      </Card>

      <Card title="Automatic resume">
        <Checkbox
          checked={draft.autoResumeEnabled}
          onChange={(autoResumeEnabled) => patch({ autoResumeEnabled })}
          label="Resume interrupted runs when the quota returns"
          hint="The master switch. Each prompt can still opt out, and a run whose task was already finished is never resumed."
        />
        <Field
          label="Wait after the reset (minutes)"
          hint="A small grace period so a resume does not land a second before the quota is actually back."
        >
          <input
            type="number"
            min={0}
            max={1440}
            value={draft.autoResumeDelayMinutes}
            onChange={(event) => patch({ autoResumeDelayMinutes: Number(event.target.value) })}
          />
        </Field>
      </Card>

      {message && (
        <div className="toast" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}
