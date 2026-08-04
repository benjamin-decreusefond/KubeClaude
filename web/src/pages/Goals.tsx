import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Badge, Banner, Card, Checkbox, Empty, Field, Meter } from '../components/primitives';
import { formatRelative } from '../format';
import { usePolled, useStream, useTicker } from '../hooks';
import type { Goal, GoalStatus, McpServer, ModelOption, PermissionMode } from '../types';

const STATUS_TONE: Record<GoalStatus, string> = {
  active: 'running',
  paused: '',
  achieved: 'good',
  abandoned: 'warning',
};

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'Working',
  paused: 'Paused',
  achieved: 'Achieved',
  abandoned: 'Stopped',
};

export function GoalBadge({ status }: { status: GoalStatus }) {
  return (
    <span className={`badge ${STATUS_TONE[status]}`}>
      <span className="badge-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function cadenceLabel(minutes: number): string {
  if (minutes <= 0) return 'back to back';
  if (minutes < 60) return `every ${minutes} min`;
  const hours = minutes / 60;
  if (hours < 24) return `every ${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  const days = hours / 24;
  return `every ${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

export function Goals() {
  const navigate = useNavigate();
  const now = useTicker(20_000);
  const { data: goals, refresh, loading } = usePolled<Goal[]>(() => api.goals(), 15_000);
  const { data: modelData } = usePolled<{ models: ModelOption[] }>(() => api.models(), 0);
  const { data: mcpServers } = usePolled<McpServer[]>(() => api.mcpServers(), 0);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [objectives, setObjectives] = useState('');
  const [continuousObjectives, setContinuousObjectives] = useState(false);
  const [model, setModel] = useState('');
  const [workingDir, setWorkingDir] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [repoRef, setRepoRef] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('bypassPermissions');
  const [mcpServerIds, setMcpServerIds] = useState<string[]>([]);
  const [cadenceMinutes, setCadenceMinutes] = useState(30);
  const [maxIterations, setMaxIterations] = useState(0);
  const [stopWhenAchieved, setStopWhenAchieved] = useState(true);
  const [keepSession, setKeepSession] = useState(true);
  const [startNow, setStartNow] = useState(true);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useStream((event) => {
    if (event === 'run:updated' || event === 'run:created') refresh();
  });

  const create = async () => {
    if (!name.trim() || !description.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const goal = await api.createGoal({
        name: name.trim(),
        description: description.trim(),
        objectives: objectives.split('\n').map((line) => line.replace(/^[-*\s[\]x]+/i, '').trim()),
        continuousObjectives,
        cadenceMinutes,
        maxIterations,
        stopWhenAchieved,
        keepSession,
        startNow,
        model: model || null,
        workingDir: workingDir || null,
        repoUrl: repoUrl || null,
        repoRef: repoRef || null,
        permissionMode,
        mcpServerIds,
      });
      navigate(`/goals/${goal.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>Goals</h1>
          <p>
            A goal is a session that does not stop at one run. Give it objectives and it keeps iterating —
            each iteration picks up the same session, does the next most valuable thing, reports what it
            achieved, and ticks off what is done.
          </p>
        </div>
        <button className="primary" onClick={() => setOpen((value) => !value)}>
          {open ? 'Cancel' : 'New goal'}
        </button>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      {open && (
        <Card title="New goal" subtitle="What should be true when this is finished?">
          <Field label="Name">
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Get the media namespace to a clean bill of health"
            />
          </Field>

          <Field
            label="Mission"
            hint="The standing brief. Every iteration reads this, so say what matters and what it must not touch."
          >
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={
                'Keep the media namespace healthy: no CrashLoopBackOff, no pending PVCs, resource ' +
                'requests that match real usage. Change one thing at a time and verify it before ' +
                'moving on. Never delete a StatefulSet.'
              }
              style={{ minHeight: 110 }}
            />
          </Field>

          <Field
            label="Objectives"
            hint="One per line. These are what gets ticked off — leave it empty for an open-ended goal that just keeps improving."
          >
            <textarea
              value={objectives}
              onChange={(event) => setObjectives(event.target.value)}
              placeholder={'Every pod is running and ready\nNo PVC has been pending for over an hour\nRequests are within 20% of observed usage'}
              style={{ minHeight: 90 }}
            />
          </Field>

          <Checkbox
            checked={continuousObjectives}
            onChange={setContinuousObjectives}
            label="These are standing missions, never finished"
            hint="For objectives like “keep it secure” or “keep it free of bugs”. No iteration can tick one off, so the goal keeps working at it instead of closing it after the first round of fixes."
          />

          <div className="grid-2">
            <Field label="Model">
              <select value={model} onChange={(event) => setModel(event.target.value)}>
                {(modelData?.models ?? []).map((option) => (
                  <option key={option.id || 'default'} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Wait between iterations (minutes)"
              hint="Measured from the end of one iteration. 0 runs them back to back, which spends the quota fast."
            >
              <input
                type="number"
                min={0}
                value={cadenceMinutes}
                onChange={(event) => setCadenceMinutes(Number(event.target.value))}
              />
            </Field>

            <Field label="Iteration limit" hint="0 keeps going until the objectives are met.">
              <input
                type="number"
                min={0}
                value={maxIterations}
                onChange={(event) => setMaxIterations(Number(event.target.value))}
              />
            </Field>

            <Field
              label="Repository"
              hint="Checked out and put back on its branch before every iteration."
            >
              <input
                type="text"
                value={repoUrl}
                onChange={(event) => setRepoUrl(event.target.value)}
                placeholder="https://github.com/owner/repo.git"
              />
            </Field>

            <Field label="Branch" hint="Empty means the remote's default.">
              <input
                type="text"
                value={repoRef}
                onChange={(event) => setRepoRef(event.target.value)}
                placeholder="main"
              />
            </Field>

            <Field label="Working directory" hint="Leave empty for a managed workspace of its own.">
              <input
                type="text"
                value={workingDir}
                onChange={(event) => setWorkingDir(event.target.value)}
                placeholder="/data/workspaces/kubernetes"
              />
            </Field>
          </div>

          <Field
            label="Permission mode"
            hint="A goal runs unattended. bypassPermissions is what lets it actually change things; default denies anything needing approval, so a goal that must write will stall."
          >
            <select
              value={permissionMode}
              onChange={(event) => setPermissionMode(event.target.value as PermissionMode)}
            >
              <option value="bypassPermissions">bypassPermissions — let it act</option>
              <option value="acceptEdits">acceptEdits — auto-approve file edits</option>
              <option value="auto">auto — the CLI judges each call, refusing the risky ones</option>
              <option value="plan">plan — research only</option>
              <option value="default">default — deny anything needing approval</option>
            </select>
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

          <Checkbox
            checked={stopWhenAchieved}
            onChange={setStopWhenAchieved}
            label="Stop once every objective is ticked"
            hint="Turn this off to keep iterating past the checklist, looking for further improvements."
          />
          <Checkbox
            checked={keepSession}
            onChange={setKeepSession}
            label="Keep one session across iterations"
            hint="Context carries forward, which is cheaper and better informed. Turn it off if the session grows unwieldy — the progress log still carries."
          />
          <Checkbox
            checked={startNow}
            onChange={setStartNow}
            label="Start the first iteration immediately"
          />

          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
            <button className="ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={creating || !name.trim() || !description.trim()}
              onClick={() => void create()}
            >
              {creating ? 'Creating…' : 'Create goal'}
            </button>
          </div>
        </Card>
      )}

      {loading && !goals && <Card>Loading…</Card>}

      {goals?.length === 0 && !open && (
        <Card>
          <Empty>
            No goals yet. A prompt answers “run this now”; a goal answers “keep working on this until it is
            true”.{' '}
            <button className="ghost small" onClick={() => setOpen(true)}>
              Set the first one
            </button>
          </Empty>
        </Card>
      )}

      {goals?.map((goal) => (
        <Card key={goal.id}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="row">
                <Link to={`/goals/${goal.id}`}>
                  <h2>{goal.name}</h2>
                </Link>
                <GoalBadge status={goal.status} />
                {goal.prompt?.model && <Badge>{goal.prompt.model}</Badge>}
                {!goal.stopWhenAchieved && <Badge>Open-ended</Badge>}
              </div>
              <p className="secondary" style={{ marginTop: 6 }}>
                {goal.description.slice(0, 220)}
                {goal.description.length > 220 ? '…' : ''}
              </p>
            </div>
            <Link to={`/goals/${goal.id}`}>
              <button className="ghost small">Open</button>
            </Link>
          </div>

          <div style={{ marginTop: 12 }}>
            <Meter
              value={goal.progress.done}
              max={Math.max(1, goal.progress.total)}
              leftLabel={
                goal.progress.total > 0
                  ? `${goal.progress.done} of ${goal.progress.total} objectives` +
                    (goal.progress.standing > 0 ? ` · ${goal.progress.standing} standing` : '')
                  : goal.progress.standing > 0
                    ? `${goal.progress.standing} standing objective${goal.progress.standing > 1 ? 's' : ''}`
                    : 'No objectives — open-ended'
              }
              rightLabel={`iteration ${goal.iteration} · ${cadenceLabel(goal.cadenceMinutes)}`}
            />
          </div>

          <div className="stat-note" style={{ marginTop: 10 }}>
            {goal.lastIterationAt
              ? `Last iteration ${formatRelative(goal.lastIterationAt, now)}`
              : 'Has not run yet'}
            {goal.maxIterations > 0 ? ` · limit ${goal.maxIterations}` : ''}
          </div>
        </Card>
      ))}
    </div>
  );
}
