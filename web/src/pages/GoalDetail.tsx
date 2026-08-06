import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Badge, Banner, Card, Checkbox, Empty, Field, Meter, StatusBadge } from '../components/primitives';
import { formatDateTime, formatRelative, formatTokens } from '../format';
import { usePolled, useStream, useTicker } from '../hooks';
import { GoalBadge, cadenceLabel } from './Goals';
import type { GoalDetail as GoalDetailType, ModelOption, Objective } from '../types';

const SOURCE_LABEL: Record<string, string> = {
  report: 'from its own report',
  judge: 'read by the review model',
  none: 'no report',
};

export function GoalDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const now = useTicker(15_000);
  const { data: goal, refresh, error } = usePolled<GoalDetailType>(() => api.goal(id), 10_000, [id]);
  const { data: modelData } = usePolled<{ models: ModelOption[] }>(() => api.models(), 0);
  const { data: template } = usePolled(() => api.iterationTemplate(), 0);

  const [newObjectives, setNewObjectives] = useState('');
  const [newStanding, setNewStanding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useStream((event) => {
    if (event === 'run:updated' || event === 'run:created') refresh();
  });

  if (error) return <Banner tone="critical">{error}</Banner>;
  if (!goal) return <Card>Loading…</Card>;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggleObjective = (objective: Objective) => {
    const objectives = goal.objectives.map((entry) =>
      entry.id === objective.id
        ? {
            ...entry,
            done: !entry.done,
            doneAt: entry.done ? null : new Date().toISOString(),
            note: entry.done ? null : 'Marked by hand',
          }
        : entry,
    );
    void act(() => api.updateGoal(goal.id, { objectives }));
  };

  /**
   * Turning an objective standing also un-ticks it: the box was closed on the
   * understanding that the work was finished, which is exactly what marking it
   * standing says was never true.
   */
  const toggleStanding = (objective: Objective) => {
    const objectives = goal.objectives.map((entry) =>
      entry.id === objective.id
        ? entry.continuous
          ? { ...entry, continuous: false }
          : { ...entry, continuous: true, done: false, doneAt: null, note: null }
        : entry,
    );
    void act(() => api.updateGoal(goal.id, { objectives }));
  };

  /**
   * Drop an objective the goal should stop chasing. The id it held is not
   * reused, so the progress log keeps meaning what it said at the time.
   */
  const removeObjective = (objective: Objective) => {
    if (!window.confirm(`Remove “${objective.text}” from this goal?`)) return;
    const objectives = goal.objectives.filter((entry) => entry.id !== objective.id);
    void act(() => api.updateGoal(goal.id, { objectives }));
  };

  const addObjectives = () => {
    const lines = newObjectives
      .split('\n')
      .map((line) => line.replace(/^[-*\s[\]x]+/i, '').trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    setNewObjectives('');
    void act(() =>
      api.updateGoal(goal.id, { addObjectives: lines, addObjectivesContinuous: newStanding }),
    );
  };

  const remove = () => {
    if (!window.confirm(`Delete “${goal.name}” and everything it ran?`)) return;
    void act(async () => {
      await api.deleteGoal(goal.id);
      navigate('/goals');
    });
  };

  const running = goal.runs.some((run) => run.status === 'queued' || run.status === 'running');

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <div className="row">
            <h1>{goal.name}</h1>
            <GoalBadge status={goal.status} />
            {running && <Badge tone="running">Iterating</Badge>}
          </div>
          <p>{goal.description}</p>
        </div>
        <div className="row">
          {goal.status === 'active' ? (
            <button className="ghost" disabled={busy} onClick={() => void act(() => api.pauseGoal(goal.id))}>
              Pause
            </button>
          ) : (
            <button className="ghost" disabled={busy} onClick={() => void act(() => api.startGoal(goal.id))}>
              {goal.status === 'paused' ? 'Resume' : 'Keep going'}
            </button>
          )}
          {/* In the header with the other things you do to a goal. It used to be
              an action on the Iterations card, where nobody looking for the
              mission or the cadence would think to open it. */}
          <button className="ghost" onClick={() => setSettingsOpen((value) => !value)}>
            {settingsOpen ? 'Hide settings' : 'Edit'}
          </button>
          <button
            className="primary"
            // Only an active goal has anything read its report, so iterating a
            // paused one would spend tokens on findings nobody collects.
            disabled={busy || running || goal.status !== 'active'}
            title={goal.status !== 'active' ? 'Resume the goal before iterating it' : undefined}
            onClick={() => void act(() => api.iterateGoal(goal.id))}
          >
            {running ? 'Iterating…' : 'Iterate now'}
          </button>
          {/* Where a prompt keeps its own Delete. It used to sit at the foot of
              the collapsed Settings card, which reads as not existing at all. */}
          <button className="danger" disabled={busy} onClick={remove}>
            Delete
          </button>
        </div>
      </header>

      {message && <Banner tone="critical">{message}</Banner>}

      {goal.status === 'paused' && (
        <Banner>
          This goal is paused, so the loop leaves it alone. Three failed iterations in a row pause a goal
          automatically — check the log below before resuming.
        </Banner>
      )}
      {goal.status === 'achieved' && (
        <Banner tone="warning" icon="✓">
          Every objective is ticked. Add another one, or resume it to keep improving past the checklist.
        </Banner>
      )}

      <Card
        title="Objectives"
        subtitle={
          (goal.progress.total > 0
            ? `${goal.progress.done} of ${goal.progress.total} done`
            : goal.progress.standing > 0
              ? 'Standing work'
              : 'Open-ended') +
          (goal.progress.standing > 0 ? ` · ${goal.progress.standing} standing` : '') +
          ` · iteration ${goal.iteration} · ${cadenceLabel(goal.cadenceMinutes)}`
        }
      >
        {goal.progress.total > 0 && (
          <div style={{ marginBottom: 14 }}>
            <Meter value={goal.progress.done} max={goal.progress.total} />
          </div>
        )}

        {goal.objectives.length === 0 ? (
          <Empty>
            No objectives — the goal keeps working from its mission alone. Add some below to give it a
            checklist to close.
          </Empty>
        ) : (
          <table className="table">
            <tbody>
              {goal.objectives.map((objective) => (
                <tr key={objective.id}>
                  <td style={{ width: 28 }}>
                    <input
                      type="checkbox"
                      checked={objective.done}
                      // A standing objective has no finish to tick, by hand or
                      // otherwise — that is what marking it standing means.
                      disabled={busy || objective.continuous}
                      aria-label={objective.text}
                      title={objective.continuous ? 'A standing objective is never finished' : undefined}
                      onChange={() => toggleObjective(objective)}
                    />
                  </td>
                  <td>
                    <span style={{ textDecoration: objective.done ? 'line-through' : undefined }}>
                      {objective.text}
                    </span>
                    {objective.continuous && (
                      <>
                        {' '}
                        <Badge>Standing</Badge>
                      </>
                    )}
                    {objective.done && objective.note && (
                      <div className="stat-note">
                        {objective.note} · {formatDateTime(objective.doneAt)}
                      </div>
                    )}
                  </td>
                  <td style={{ width: 150, textAlign: 'right' }}>
                    <button
                      className="ghost small"
                      disabled={busy}
                      title={
                        objective.continuous
                          ? 'Let iterations tick this off again'
                          : 'Never let an iteration tick this off'
                      }
                      onClick={() => toggleStanding(objective)}
                    >
                      {objective.continuous ? 'Closable' : 'Standing'}
                    </button>
                    <button
                      className="ghost small"
                      disabled={busy}
                      title="Remove this objective"
                      onClick={() => removeObjective(objective)}
                    >
                      Remove
                    </button>
                  </td>
                  <td className="muted num" style={{ width: 48 }}>
                    {objective.id}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 14 }}>
          <Field label="Add objectives" hint="One per line. New ones are picked up by the next iteration.">
            <textarea
              value={newObjectives}
              onChange={(event) => setNewObjectives(event.target.value)}
              placeholder="Alerts fire before users notice"
              style={{ minHeight: 60 }}
            />
          </Field>
          <Checkbox
            checked={newStanding}
            onChange={setNewStanding}
            label="Standing missions, never finished"
            hint="No iteration can tick these off, so the goal keeps working at them."
          />
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="small" disabled={busy || !newObjectives.trim()} onClick={addObjectives}>
              Add
            </button>
          </div>
        </div>
      </Card>

      <Card
        title="Progress"
        subtitle="What each iteration reported, oldest first."
        actions={
          <button className="ghost small" onClick={refresh}>
            Refresh
          </button>
        }
      >
        {goal.iterations.length === 0 ? (
          <Empty>Nothing yet. The first iteration writes the first entry here.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {goal.iterations.map((entry) => (
                <tr key={entry.id}>
                  <td className="num muted" style={{ width: 36 }}>
                    {entry.seq}
                  </td>
                  <td>
                    <div>{entry.summary}</div>
                    {entry.nextStep && <div className="stat-note">Next: {entry.nextStep}</div>}
                    <div className="stat-note">
                      {formatRelative(entry.createdAt, now)} · {SOURCE_LABEL[entry.source] ?? entry.source}
                      {entry.achieved.length > 0 ? ` · closed ${entry.achieved.join(', ')}` : ''}
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', width: 130 }}>
                    {entry.runId && (
                      <Link to={`/runs/${entry.runId}`}>
                        <button className="ghost small">Run</button>
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card
        title="Iterations"
        subtitle="Every run this goal has made."
      >
        {goal.runs.length === 0 ? (
          <Empty>No runs yet.</Empty>
        ) : (
          <table className="table">
            <tbody>
              {goal.runs.map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={`/runs/${run.id}`}>{formatDateTime(run.queuedAt)}</Link>
                    <div className="stat-note">{formatRelative(run.queuedAt, now)}</div>
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

      {settingsOpen && (
        <Card title="Settings" subtitle="What this goal is after, how hard it pushes, and what it runs as.">
          {/* The mission is read by every iteration, so it is the thing most
              worth being able to change once you have seen what the goal does
              with it. Saved on blur, like everything else on this card. */}
          <Field label="Name">
            <input
              type="text"
              defaultValue={goal.name}
              onBlur={(event) => {
                const name = event.target.value.trim();
                if (name && name !== goal.name) void act(() => api.updateGoal(goal.id, { name }));
              }}
            />
          </Field>
          <Field label="Mission" hint="The standing brief every iteration reads.">
            <textarea
              defaultValue={goal.description}
              style={{ minHeight: 90 }}
              onBlur={(event) => {
                const description = event.target.value;
                if (description !== goal.description) {
                  void act(() => api.updateGoal(goal.id, { description }));
                }
              }}
            />
          </Field>

          {/* How it iterates, not just what it is after. The default suits a
              goal that lands changes; one that triages or sweeps wants its own,
              and this is where it says so. */}
          <Field
            label="How it iterates"
            hint={
              'The brief every iteration is given under “This iteration”. Empty falls back to the ' +
              'built-in one, shown here in grey. ' +
              (template ? `Placeholders: ${template.placeholders.map((name) => `{{${name}}}`).join(', ')}.` : '')
            }
          >
            <textarea
              key={goal.iterationInstruction ?? 'default'}
              defaultValue={goal.iterationInstruction ?? ''}
              placeholder={template?.instruction ?? ''}
              style={{ minHeight: 120 }}
              onBlur={(event) => {
                const next = event.target.value.trim() || null;
                if (next !== goal.iterationInstruction) {
                  void act(() => api.updateGoal(goal.id, { iterationInstruction: next }));
                }
              }}
            />
          </Field>

          <div className="grid-2">
            <Field label="Wait between iterations (minutes)">
              <input
                type="number"
                min={0}
                defaultValue={goal.cadenceMinutes}
                onBlur={(event) =>
                  void act(() => api.updateGoal(goal.id, { cadenceMinutes: Number(event.target.value) }))
                }
              />
            </Field>
            <Field label="Iteration limit" hint="0 keeps going until the objectives are met.">
              <input
                type="number"
                min={0}
                defaultValue={goal.maxIterations}
                onBlur={(event) =>
                  void act(() => api.updateGoal(goal.id, { maxIterations: Number(event.target.value) }))
                }
              />
            </Field>
            <Field label="Model">
              <select
                value={goal.prompt?.model ?? ''}
                onChange={(event) => void act(() => api.updateGoal(goal.id, { model: event.target.value || null }))}
              >
                {(modelData?.models ?? []).map((option) => (
                  <option key={option.id || 'default'} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="Review model"
              hint="Only used when an iteration forgets to write its report. Empty means never spend a second call."
            >
              <select
                value={goal.reviewModel ?? ''}
                onChange={(event) =>
                  void act(() => api.updateGoal(goal.id, { reviewModel: event.target.value || null }))
                }
              >
                <option value="">None — carry on without a summary</option>
                {(modelData?.models ?? [])
                  .filter((option) => option.id)
                  .map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </Field>
          </div>

          <Checkbox
            checked={goal.stopWhenAchieved}
            onChange={(value) => void act(() => api.updateGoal(goal.id, { stopWhenAchieved: value }))}
            label="Stop once every objective is ticked"
            hint="Off keeps it iterating past the checklist, looking for further improvements."
          />
          <Checkbox
            checked={goal.prompt?.continueSession ?? true}
            onChange={(value) => void act(() => api.updateGoal(goal.id, { keepSession: value }))}
            label="Keep one session across iterations"
          />

          <div className="row" style={{ marginTop: 18 }}>
            <span className="stat-note">
              Workspace: {goal.prompt?.workingDir ?? 'managed'} · created {formatDateTime(goal.createdAt)}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
