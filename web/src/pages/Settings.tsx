import { useEffect, useState } from 'react';
import { api } from '../api';
import { KeyValueEditor } from '../components/KeyValueEditor';
import { Badge, Banner, Card, Checkbox, Field } from '../components/primitives';
import { SecuritySettings } from '../components/SecuritySettings';
import { formatTokens } from '../format';
import { usePolled } from '../hooks';
import type { BillingMode, BudgetBasis, Capabilities, ModelOption, Settings, Status } from '../types';

const BILLING_NOTE: Record<BillingMode, string> = {
  subscription:
    'Your Claude plan pays for these runs, exactly as it does in the desktop app or the terminal — no per-token charge. That also means the 5-hour and weekly windows below track a real allowance, and running out of it is what auto-resume waits on.',
  api: 'Per-token API billing against your Console credit. There is no 5-hour or weekly allowance to run out of, so the quota triggers and auto-resume degrade to plain schedules. Set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) to spend a subscription instead.',
  gateway:
    'Requests go through your own gateway, so how they are billed is between you and it. The quota windows below only mean something if the gateway is fronting a subscription.',
  none: 'No credential is configured.',
};

const BASIS_HINTS: Record<BudgetBasis, string> = {
  weighted:
    'Recommended. A long run re-reads its cached prefix every turn, so cache reads dominate the raw count while costing a tenth of a fresh input token. Weighting them keeps the gauge honest.',
  input_output: 'Ignores cache traffic entirely. Simple, but understates a run that writes a large cache.',
  total: 'Sums every reported token. Expect the gauge to hit 100% within one agentic run.',
};

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
          <>
            <p className="secondary">
              Authenticated with{' '}
              {(capabilities?.credentials.variables ?? []).map((name, index) => (
                <span key={name}>
                  {index > 0 ? ', ' : ''}
                  <code>{name}</code>
                </span>
              ))}
              .
            </p>
            <p className="stat-note">{BILLING_NOTE[capabilities?.credentials.mode ?? 'none']}</p>
            {capabilities?.credentials.ignored.length ? (
              <Banner tone="warning">
                Also set in the pod but <strong>not</strong> forwarded:{' '}
                {capabilities.credentials.ignored.map((name, index) => (
                  <span key={name}>
                    {index > 0 ? ', ' : ''}
                    <code>{name}</code>
                  </span>
                ))}
                . Only one credential is passed to a run, so there is never a question of which
                one pays. Unset it to remove the ambiguity entirely.
              </Banner>
            ) : null}
          </>
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

      <Card
        title="Git"
        subtitle="How a run reaches a repository, and what its commits are signed with"
      >
        <div className="grid-2">
          <Field label="Committer name" hint="Author and committer on every commit a run makes.">
            <input
              type="text"
              value={draft.gitUserName}
              onChange={(event) => patch({ gitUserName: event.target.value })}
              placeholder="KubeClaude"
            />
          </Field>
          <Field label="Committer email" hint="Use an address your host will accept on a push.">
            <input
              type="email"
              value={draft.gitUserEmail}
              onChange={(event) => patch({ gitUserEmail: event.target.value })}
              placeholder="kubeclaude@localhost"
            />
          </Field>
        </div>

        {capabilities?.git.githubToken ? (
          <p className="secondary">
            <code>GITHUB_TOKEN</code> is set and forwarded, so <code>git</code> pushes over HTTPS and{' '}
            <code>gh</code> both authenticate without a prompt asking for anything.
          </p>
        ) : capabilities?.git.tokenWithheld ? (
          <Banner tone="warning">
            A GitHub token is set in the pod but <code>EXPOSE_GITHUB_TOKEN</code> is off, so runs cannot use
            it. They can still clone public repositories; pushing will fail.
          </Banner>
        ) : (
          <Banner tone="warning">
            No <code>GITHUB_TOKEN</code> in the pod environment. Runs can clone public repositories over
            HTTPS, but cannot push or use <code>gh</code>. Set it on the deployment and restart.
          </Banner>
        )}
        <p className="stat-note">
          The credential is never written to disk: the gitconfig KubeClaude writes reads the token from the
          environment at the moment git asks for it, so rotating it needs no change here.
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

        <Field
          label="Fallback models"
          hint="Tried in order when the model above is overloaded or unavailable, for every prompt that does not name its own chain. Comma-separated."
        >
          <input
            type="text"
            value={draft.defaultFallbackModel ?? ''}
            onChange={(event) => patch({ defaultFallbackModel: event.target.value || null })}
            placeholder="sonnet,haiku"
          />
        </Field>

        <Field
          label="Default effort"
          hint="How hard the model works per turn, for prompts that do not pin their own. Left alone, the CLI decides."
        >
          <select
            value={draft.defaultEffort ?? ''}
            onChange={(event) => patch({ defaultEffort: (event.target.value || null) as Settings['defaultEffort'] })}
          >
            <option value="">CLI default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="max">max</option>
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
                : 'Unset — the overview shows totals instead of a gauge, and quota triggers fall back to firing once per window. Anthropic does not publish an exact number; community estimates put Pro near 44k, Max 5x near 88k and Max 20x near 220k per window, which are reasonable starting points to calibrate against what you observe.'
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

        <Field
          label="What counts against the budget"
          hint={BASIS_HINTS[draft.budgetBasis]}
        >
          <select
            value={draft.budgetBasis}
            onChange={(event) => patch({ budgetBasis: event.target.value as BudgetBasis })}
          >
            <option value="weighted">Weighted (cache reads x0.1, cache writes x1.25)</option>
            <option value="input_output">Input + output only</option>
            <option value="total">Every token at face value</option>
          </select>
        </Field>

        <Checkbox
          checked={draft.quotaGuardEnabled}
          onChange={(quotaGuardEnabled) => patch({ quotaGuardEnabled })}
          label="Hold runs back once a budget is spent"
          hint="Held runs are parked and resumed when the window rolls over, rather than failing. Needs a budget above."
        />

        <div className="grid-2">
          <Field
            label="Default turn cap"
            hint={
              draft.defaultMaxTurns > 0
                ? `Prompts that do not set their own stop after ${draft.defaultMaxTurns} turns. Every turn re-sends the whole conversation, so this stops a looping run from eating a window — but set it too low and real work stops half-done: changing code and opening a pull request takes well over thirty. A run that hits it can be resumed.`
                : 'Off — a prompt with no cap of its own can run as long as it likes. A prompt can always set 0 to opt out individually.'
            }
          >
            <input
              type="number"
              min={0}
              value={draft.defaultMaxTurns}
              onChange={(event) => patch({ defaultMaxTurns: Number(event.target.value) })}
            />
          </Field>
          <Field
            label="Per-run token ceiling"
            hint={
              draft.runTokenCap > 0
                ? `A run is killed on the turn it passes ${formatTokens(draft.runTokenCap)}, counted the same way as the budgets above. Its spend is still recorded, and it is never auto-resumed.`
                : 'Off. Set one to stop a single run from spending a whole window — it kills the run mid-task, so it is deliberately opt-in.'
            }
          >
            <input
              type="number"
              min={0}
              step={10000}
              value={draft.runTokenCap}
              onChange={(event) => patch({ runTokenCap: Number(event.target.value) })}
            />
          </Field>
        </div>

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

      <Card title="Notifications">
        <Field
          label="Webhook URL"
          hint="POSTed a JSON summary when a run finishes — a Slack incoming webhook or any endpoint that accepts JSON. Empty disables notifications."
        >
          <input
            type="url"
            placeholder="https://hooks.slack.com/services/…"
            value={draft.notifyWebhookUrl}
            onChange={(event) => patch({ notifyWebhookUrl: event.target.value })}
          />
        </Field>
        <Checkbox
          checked={draft.notifyOnFailure}
          onChange={(notifyOnFailure) => patch({ notifyOnFailure })}
          label="Notify on failure"
          hint="Failed, timed out, capped, or stuck rate-limited with no resume scheduled."
        />
        <Checkbox
          checked={draft.notifyOnSuccess}
          onChange={(notifyOnSuccess) => patch({ notifyOnSuccess })}
          label="Notify on success"
          hint="Off by default — most runs succeeding is the expected, quiet outcome."
        />
      </Card>

      <SecuritySettings />

      {message && (
        <div className="toast" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}
