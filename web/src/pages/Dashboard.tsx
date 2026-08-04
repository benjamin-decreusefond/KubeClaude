import { Link } from 'react-router-dom';
import { api } from '../api';
import { BarList, ColumnChart, StackedBar } from '../components/charts';
import { Banner, Card, Empty, Meter, Stat, StatusBadge } from '../components/primitives';
import {
  formatCost,
  formatDuration,
  formatNumber,
  formatPct,
  formatRelative,
  formatTokens,
  triggerLabel,
} from '../format';
import { usePolled, useStream, useTicker } from '../hooks';
import type { BudgetBasis, Dashboard as DashboardData, QuotaSlice, Status } from '../types';

const BASIS_NOTE: Record<BudgetBasis, string> = {
  weighted: 'Cache reads count at 0.1x and cache writes at 1.25x.',
  input_output: 'Cache traffic is excluded.',
  total: '',
};

export function Dashboard() {
  const { data, refresh } = usePolled<DashboardData>(() => api.dashboard(), 20_000);
  const { data: status } = usePolled<Status>(() => api.status(), 20_000);
  const now = useTicker(15_000);

  // Live updates: any run change or usage change makes the numbers stale.
  useStream((event) => {
    if (event === 'run:updated' || event === 'run:created' || event === 'quota:changed') refresh();
  });

  if (!data) {
    return (
      <div>
        <h1>Overview</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Loading Claude usage…
        </p>
      </div>
    );
  }

  const { quota, totals } = data;
  const sessionTotals = totals.session;

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            What Claude has spent, what is running, and what is scheduled next. Token and cost figures
            come from the CLI's own report on each run.
          </p>
        </div>
        <div className="row">
          {status && !status.credentialsConfigured && (
            <span className="badge critical">
              <span className="badge-dot" />
              No Claude credentials
            </span>
          )}
          <Link to="/prompts/new">
            <button className="primary">New prompt</button>
          </Link>
        </div>
      </header>

      {status && !status.credentialsConfigured && (
        <Banner tone="critical">
          No Claude credentials are configured. Set <code>CLAUDE_CODE_OAUTH_TOKEN</code> (subscription) or{' '}
          <code>ANTHROPIC_API_KEY</code> (API billing) in the deployment and restart the pod — runs will fail
          until then.
        </Banner>
      )}

      {!quota.canRun && quota.reason && (
        <Banner tone="warning">
          {quota.reason}. New runs are held until the quota resets
          {quota.session.resetsAt ? ` ${formatRelative(quota.session.resetsAt, now)}` : ''}.
        </Banner>
      )}

      {/* The two quota windows are the headline of this page. */}
      <div className="grid-2">
        <QuotaCard
          slice={quota.session}
          title="Current 5-hour session"
          emptyNote="No session window is open — the full allowance is available and the next run starts a fresh one."
          runCount={sessionTotals.runs}
          cost={sessionTotals.costUsd}
          now={now}
        />
        <QuotaCard
          slice={quota.weekly}
          title="Current week"
          emptyNote="No weekly window is open yet. The next run opens one."
          runCount={totals.week.runs}
          cost={totals.week.costUsd}
          now={now}
        />
      </div>

      <div className="grid-3">
        <Card>
          <Stat
            label="Tokens this session"
            value={formatTokens(sessionTotals.totalTokens)}
            note={`${sessionTotals.runs} run${sessionTotals.runs === 1 ? '' : 's'} · ${formatCost(sessionTotals.costUsd)}`}
          />
        </Card>
        <Card>
          <Stat
            label="Tokens this week"
            value={formatTokens(totals.week.totalTokens)}
            note={`${formatCost(totals.week.costUsd)} · ${formatNumber(totals.week.turns)} turns`}
          />
        </Card>
        <Card>
          <Stat
            label="Runs succeeded (30d)"
            value={`${totals.month.succeeded}/${totals.month.runs}`}
            note={
              totals.month.runs > 0
                ? [
                    `${totals.month.failed} failed`,
                    `${totals.month.rateLimited} stopped on quota`,
                    // Only when there are any: on an instance that is not
                    // redeployed mid-run this is always zero, and a permanent
                    // "0 interrupted" is noise.
                    ...(totals.month.interrupted > 0
                      ? [`${totals.month.interrupted} cut short by a restart`]
                      : []),
                  ].join(' · ')
                : 'No runs yet'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Awaiting quota"
            value={data.awaitingResume.length}
            note={
              data.awaitingResume.length > 0
                ? 'Will resume automatically when tokens return'
                : 'Nothing parked'
            }
          />
        </Card>
        <Card>
          <Stat
            label="Time in Claude (30d)"
            value={formatDuration(totals.month.apiDurationMs)}
            note={`${formatDuration(totals.month.durationMs)} wall clock`}
          />
        </Card>
        <Card>
          <Stat
            label="Spend (30d)"
            value={formatCost(totals.month.costUsd)}
            note={`${formatCost(totals.allTime.costUsd)} all time`}
          />
        </Card>
      </div>

      <div className="grid-2">
        <Card
          title="Token mix — current session"
          subtitle="Cache reads are billed far cheaper than fresh input, so the split matters"
        >
          <StackedBar
            segments={[
              { label: 'Input', value: sessionTotals.inputTokens, color: 'var(--series-1)' },
              { label: 'Output', value: sessionTotals.outputTokens, color: 'var(--series-2)' },
              { label: 'Cache write', value: sessionTotals.cacheCreationTokens, color: 'var(--series-3)' },
              { label: 'Cache read', value: sessionTotals.cacheReadTokens, color: 'var(--series-4)' },
            ]}
          />
        </Card>

        <Card title="Tokens per day" subtitle="Last 14 days, all prompts">
          <ColumnChart
            points={data.daily.map((point) => ({
              label: point.date.slice(5),
              value: point.totalTokens,
              title: `${point.date}: ${formatTokens(point.totalTokens)} tokens, ${point.runs} runs, ${formatCost(point.costUsd)}`,
            }))}
            tickEvery={3}
          />
        </Card>
      </div>

      <div className="grid-2">
        <Card title="By model" subtitle="Last 30 days">
          {data.models.length === 0 ? (
            <Empty>No model usage recorded yet.</Empty>
          ) : (
            <BarList
              rows={data.models.map((model) => ({
                label: model.model,
                value: model.totalTokens,
                display: `${formatTokens(model.totalTokens)} · ${formatCost(model.costUsd)}`,
              }))}
            />
          )}
        </Card>

        <Card title="By prompt" subtitle="Last 7 days">
          {data.prompts.length === 0 ? (
            <Empty>No runs in the last week.</Empty>
          ) : (
            <BarList
              rows={data.prompts.map((prompt) => ({
                label: prompt.promptName,
                value: prompt.totalTokens,
                display: `${formatTokens(prompt.totalTokens)} · ${prompt.runs} runs`,
              }))}
            />
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Scheduled next">
          {data.upcoming.length === 0 ? (
            <Empty>No triggers are armed. Add one to a prompt to run it on a schedule.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {data.upcoming.map((item) => (
                  <tr key={item.triggerId}>
                    <td>
                      <Link to={`/prompts/${item.promptId}`}>{item.promptName}</Link>
                      <div className="stat-note">
                        {triggerLabel(item.type)}
                        {item.cronExpression ? ` · ${item.cronExpression}` : ''}
                      </div>
                    </td>
                    <td className="num muted">{formatRelative(item.nextFireAt, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent runs" actions={<Link to="/runs">See all</Link>}>
          {data.recentRuns.length === 0 ? (
            <Empty>Nothing has run yet.</Empty>
          ) : (
            <table className="table">
              <tbody>
                {data.recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <Link to={`/runs/${run.id}`}>{run.promptName}</Link>
                      <div className="stat-note">
                        {triggerLabel(run.triggerType)} · {formatRelative(run.queuedAt, now)}
                      </div>
                    </td>
                    <td className="num muted">{formatTokens(run.totalTokens)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <StatusBadge status={run.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  );
}

function QuotaCard({
  slice,
  title,
  emptyNote,
  runCount,
  cost,
  now,
}: {
  slice: QuotaSlice;
  title: string;
  emptyNote: string;
  runCount: number;
  cost: number;
  now: number;
}) {
  const budgeted = slice.budget > 0;
  const usedPct = budgeted ? (slice.used / slice.budget) * 100 : 0;
  const tone = usedPct >= 100 ? 'critical' : usedPct >= 80 ? 'warning' : 'default';

  return (
    <Card
      title={title}
      subtitle={
        slice.fresh
          ? 'Fully reset'
          : slice.resetsAt
            ? `Resets ${formatRelative(slice.resetsAt, now)}${
                slice.resetsAtObserved ? '' : ' (estimated)'
              }`
            : undefined
      }
    >
      <Stat
        label={budgeted && slice.basis !== 'total' ? 'Tokens counted' : 'Tokens used'}
        value={formatTokens(slice.used)}
        hero
        note={
          budgeted
            ? `of ${formatTokens(slice.budget)} budgeted · ${formatPct(slice.remainingPct)} left`
            : `${runCount} run${runCount === 1 ? '' : 's'} · ${formatCost(cost)}`
        }
      />

      {budgeted ? (
        <div style={{ marginTop: 14 }}>
          <Meter
            value={slice.used}
            max={slice.budget}
            tone={tone}
            leftLabel={`${formatTokens(slice.remaining ?? 0)} left`}
            rightLabel={slice.window ? `${slice.window.runCount} runs in window` : undefined}
          />
          {slice.window && slice.basis !== 'total' ? (
            <p className="stat-note" style={{ marginTop: 8 }}>
              {BASIS_NOTE[slice.basis]} Raw total this window: {formatTokens(slice.window.totalTokens)}.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="stat-note" style={{ marginTop: 12 }}>
          {slice.fresh
            ? emptyNote
            : 'No token budget is configured, so this is a running total rather than a share of a limit. Set one in Settings to get a gauge and quota-aware triggers.'}
        </p>
      )}
    </Card>
  );
}
