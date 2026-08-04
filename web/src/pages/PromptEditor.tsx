import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, describeError } from '../api';
import { KeyValueEditor, ListEditor } from '../components/KeyValueEditor';
import { Badge, Banner, Card, Checkbox, Field, StatusBadge } from '../components/primitives';
import { formatRelative, formatTokens, triggerLabel } from '../format';
import { usePolled } from '../hooks';
import { TriggerList } from './TriggerEditor';
import type { AgentDefinition, Capabilities, McpServer, ModelOption, Prompt, Settings, ToolPreset } from '../types';

// This editor only ever handles scheduled prompts; chats are edited by talking
// to them, so kind and title are not part of the form.
type Draft = Omit<
  Prompt,
  'id' | 'kind' | 'title' | 'createdAt' | 'updatedAt' | 'lastSessionId' | 'triggers' | 'lastRun' | 'recentRuns'
>;

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  prompt: '',
  enabled: true,
  model: null,
  fallbackModel: null,
  effort: null,
  maxBudgetUsd: null,
  workingDir: null,
  addDirs: [],
  repoUrl: null,
  repoRef: null,
  permissionMode: 'default',
  allowedTools: [],
  disallowedTools: [],
  appendSystemPrompt: null,
  systemPrompt: null,
  agentsJson: null,
  agentIds: [],
  builtinTools: null,
  settingSources: null,
  maxTurns: null,
  timeoutSeconds: 1800,
  env: {},
  mcpConfig: null,
  mcpServerIds: [],
  settingsJson: null,
  claudeMd: null,
  continueSession: false,
  autoResume: true,
  maxAutoResumes: 5,
  resumePrompt: null,
  completionCheck: 'marker',
  completionMarker: null,
  judgeModel: null,
};

/** Enough to read a repository and change it; the starting point for narrowing. */
const DEFAULT_BUILTIN_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'TodoWrite'];

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const EFFORT_HINTS: Record<string, string> = {
  low: 'Least thinking per turn: cheapest and fastest, for mechanical work.',
  medium: 'Balanced; a sensible middle for most scheduled tasks.',
  high: 'More thinking per turn, at proportionally more tokens.',
  xhigh: 'Harder still. Worth it for genuinely difficult reasoning, not for volume.',
  max: 'Everything the model has. Expect the token bill to match.',
};

const TABS = ['Task', 'Access', 'Schedule', 'Resume', 'Advanced'] as const;
type Tab = (typeof TABS)[number];

export function PromptEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = !id;

  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [tab, setTab] = useState<Tab>('Task');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const { data: existing, refresh } = usePolled<Prompt | null>(
    () => (id ? api.prompt(id) : Promise.resolve(null)),
    0,
    [id],
  );
  const { data: modelData } = usePolled<{ models: ModelOption[] }>(() => api.models(), 0);
  const { data: mcpServers } = usePolled<McpServer[]>(() => api.mcpServers(), 0);
  const { data: agents } = usePolled<AgentDefinition[]>(() => api.agents(), 0);
  const { data: capabilities } = usePolled<Capabilities>(() => api.capabilities(), 0);
  const { data: settings } = usePolled<Settings>(() => api.settings(), 0);
  const { data: presetData } = usePolled<{ presets: ToolPreset[] }>(() => api.toolPresets(), 0);

  useEffect(() => {
    if (!existing) return;
    const {
      id: _id,
      kind: _kind,
      title: _title,
      createdAt,
      updatedAt,
      lastSessionId,
      triggers,
      lastRun,
      recentRuns,
      ...rest
    } = existing;
    setDraft(rest);
    // Deliberately keyed on identity rather than on `existing` itself: the
    // prompt is polled, and depending on the object would throw away whatever
    // the person is in the middle of typing on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id, existing?.updatedAt]);

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  // Memoised because a fresh [] on every render would re-run everything that
  // depends on it.
  const models = useMemo(() => modelData?.models ?? [], [modelData]);
  const presets = presetData?.presets ?? [];
  const defaultMaxTurns = settings?.defaultMaxTurns ?? 0;
  // What the previous run had to re-read before it could do anything new. The
  // cached prefix is the honest measure of how heavy a continued session got.
  const lastRun = existing?.lastRun;
  const contextTokens = lastRun
    ? lastRun.cacheReadTokens + lastRun.cacheCreationTokens + lastRun.inputTokens
    : 0;
  const knownModel = useMemo(
    () => models.some((model) => model.id === (draft.model ?? '')),
    [models, draft.model],
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        const created = await api.createPrompt(draft);
        navigate(`/prompts/${created.id}`, { replace: true });
        setMessage('Prompt created');
      } else {
        await api.updatePrompt(id, draft);
        refresh();
        setMessage('Saved');
      }
    } catch (cause) {
      setError(describeError(cause));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    if (!id) return;
    const run = await api.runPrompt(id);
    navigate(`/runs/${run.id}`);
  };

  const remove = async () => {
    if (!id || !confirm(`Delete “${draft.name}” and all of its run history?`)) return;
    await api.deletePrompt(id);
    navigate('/prompts');
  };

  const duplicate = async () => {
    if (!id) return;
    const copy = await api.duplicatePrompt(id);
    navigate(`/prompts/${copy.id}`);
    setMessage('Duplicated — triggers were not copied');
  };

  const exportPrompt = async () => {
    if (!id) return;
    const portable = await api.exportPrompt(id);
    const blob = new Blob([JSON.stringify(portable, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(draft.name || 'prompt').replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>{isNew ? 'New prompt' : draft.name || 'Prompt'}</h1>
          <p>
            A prompt is a standing task. Claude runs it headless with the tools and connections you grant
            here, and carries it to the end on its own.
          </p>
        </div>
        <div className="row">
          {!isNew && (
            <>
              <button type="button" onClick={() => void runNow()}>
                Run now
              </button>
              <button type="button" onClick={() => void duplicate()}>
                Duplicate
              </button>
              <button type="button" onClick={() => void exportPrompt()}>
                Export
              </button>
              <button type="button" className="danger" onClick={() => void remove()}>
                Delete
              </button>
            </>
          )}
          <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create prompt' : 'Save'}
          </button>
        </div>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      <nav className="tabs">
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            className={`tab${tab === name ? ' active' : ''}`}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>

      {tab === 'Task' && (
        <div className="stack">
          <Card>
            <Field label="Name">
              <input
                type="text"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                placeholder="Merge green dependency PRs"
              />
            </Field>
            <Field label="Description" hint="Shown in lists. Optional.">
              <input
                type="text"
                value={draft.description}
                onChange={(event) => patch({ description: event.target.value })}
              />
            </Field>
            <Field
              label="Prompt"
              hint="What Claude should do. Write it as a complete standalone task — nothing else is in context."
            >
              <textarea
                value={draft.prompt}
                onChange={(event) => patch({ prompt: event.target.value })}
                style={{ minHeight: 200 }}
                placeholder={
                  'Check the open pull requests on <repo>.\n' +
                  'For each one where CI is green and the diff only touches dependencies, merge it.\n' +
                  'Leave a comment on the ones you skip, saying why.'
                }
              />
            </Field>
            <Checkbox
              checked={draft.enabled}
              onChange={(enabled) => patch({ enabled })}
              label="Enabled"
              hint="A disabled prompt keeps its triggers but never fires."
            />
          </Card>

          <Card title="Model">
            <Field
              label="Claude model"
              hint={
                models.find((model) => model.id === (draft.model ?? ''))?.description ??
                'Any model id your account can reach. Aliases track the current version of a tier.'
              }
            >
              <select
                value={knownModel ? (draft.model ?? '') : '__custom'}
                onChange={(event) =>
                  patch({ model: event.target.value === '__custom' ? (draft.model ?? '') : event.target.value || null })
                }
              >
                {models.map((model) => (
                  <option key={model.id || 'default'} value={model.id}>
                    {model.label}
                  </option>
                ))}
                <option value="__custom">Other (type an id)</option>
              </select>
            </Field>
            {!knownModel && (
              <Field label="Model id">
                <input
                  type="text"
                  value={draft.model ?? ''}
                  onChange={(event) => patch({ model: event.target.value || null })}
                  placeholder="claude-opus-5"
                />
              </Field>
            )}
            {settings?.defaultModel && !draft.model && (
              <p className="stat-note">
                Falls back to the global default, <code>{settings.defaultModel}</code>.
              </p>
            )}

            <Field
              label="Fallback models"
              hint={
                settings?.defaultFallbackModel && !draft.fallbackModel
                  ? `Empty inherits the global chain, ${settings.defaultFallbackModel}.`
                  : 'Tried in order when the model above is overloaded or unavailable. Nobody is there to retry a 3am run by hand, so this is what keeps it from failing outright. Comma-separated.'
              }
            >
              <input
                type="text"
                value={draft.fallbackModel ?? ''}
                onChange={(event) => patch({ fallbackModel: event.target.value || null })}
                placeholder="sonnet,haiku"
              />
            </Field>

            <Field
              label="Effort"
              hint={
                draft.effort
                  ? EFFORT_HINTS[draft.effort]
                  : settings?.defaultEffort
                    ? `Inherits the global default, ${settings.defaultEffort}.`
                    : 'How hard the model works per turn. Left alone, the CLI decides.'
              }
            >
              <select
                value={draft.effort ?? ''}
                onChange={(event) => patch({ effort: (event.target.value || null) as Draft['effort'] })}
              >
                <option value="">CLI default</option>
                {EFFORT_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </Field>
          </Card>
        </div>
      )}

      {tab === 'Access' && (
        <div className="stack">
          <Card
            title="Tool permissions"
            subtitle="What Claude may do without a human present"
          >
            <Field
              label="Permission mode"
              hint={
                draft.permissionMode === 'bypassPermissions'
                  ? 'Every tool runs without asking. The run can change files, push commits and merge PRs unattended — only use this where that is the point.'
                  : draft.permissionMode === 'default'
                    ? 'Tools that would need approval are denied, since nobody can approve them. Safe, but a task that has to write will stall.'
                    : draft.permissionMode === 'acceptEdits'
                      ? 'File edits are auto-approved; other tools still need permission.'
                      : draft.permissionMode === 'auto'
                        ? 'The CLI classifies each tool call: ordinary work runs, and what it flags as risky — force pushes, production deploys, secret writes — needs an approval no unattended run can get, so it is refused. The middle ground between “stalls on everything” and “does anything”.'
                        : 'Plan mode: Claude researches and proposes, but changes nothing.'
              }
            >
              <select
                value={draft.permissionMode}
                onChange={(event) => patch({ permissionMode: event.target.value as Draft['permissionMode'] })}
              >
                <option value="default">default — deny anything needing approval</option>
                <option value="plan">plan — research only, no changes</option>
                <option value="acceptEdits">acceptEdits — auto-approve file edits</option>
                <option value="auto">auto — the CLI judges each call, refusing the risky ones</option>
                <option value="bypassPermissions">bypassPermissions — no prompts at all</option>
              </select>
            </Field>

            <Field
              label="Start from a preset"
              hint="Every tool Claude can reach carries its schema in the system prompt of every request, so a shorter list is cheaper on every turn. Picking one sets the permission mode and both lists above; edit them freely afterwards, then Save."
            >
              <select
                value=""
                onChange={(event) => {
                  const preset = presets.find((entry) => entry.id === event.target.value);
                  if (preset) {
                    patch({
                      permissionMode: preset.permissionMode,
                      allowedTools: preset.allowedTools,
                      disallowedTools: preset.disallowedTools,
                    });
                    // "Everything" is empty lists on an already-empty prompt, so
                    // without this the control changes nothing anybody can see
                    // and reads as broken. Say what it did, and that it is not
                    // saved yet.
                    setMessage(`${preset.label} applied — permission mode ${preset.permissionMode}. Save to keep it.`);
                  }
                }}
              >
                <option value="">Choose a preset…</option>
                {presets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label} — {preset.description}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Allowed tools"
              hint='One per line. Supports scoping, e.g. Bash(gh pr merge:*) or mcp__github__merge_pull_request. Empty means "the mode decides".'
            >
              <ListEditor
                value={draft.allowedTools}
                onChange={(allowedTools) => patch({ allowedTools })}
                placeholder={'Bash(gh:*)\nEdit\nmcp__github__*'}
              />
            </Field>

            <Field label="Denied tools" hint="Takes precedence over the allow list.">
              <ListEditor
                value={draft.disallowedTools}
                onChange={(disallowedTools) => patch({ disallowedTools })}
                placeholder={'Bash(rm:*)\nWebFetch'}
              />
            </Field>
          </Card>

          <Card
            title="MCP connections"
            subtitle="Servers that already run elsewhere — KubeClaude only passes the connection details to Claude"
          >
            {(mcpServers ?? []).length === 0 ? (
              <p className="stat-note">
                None registered yet. <Link to="/mcp">Add a connection</Link> to give Claude GitHub, your
                cluster, or anything else that speaks MCP.
              </p>
            ) : (
              <div>
                {(mcpServers ?? []).map((server) => (
                  <Checkbox
                    key={server.id}
                    checked={draft.mcpServerIds.includes(server.id)}
                    onChange={(checked) =>
                      patch({
                        mcpServerIds: checked
                          ? [...draft.mcpServerIds, server.id]
                          : draft.mcpServerIds.filter((value) => value !== server.id),
                      })
                    }
                    label={
                      <>
                        <code>{server.name}</code>
                        {!server.enabled && ' (disabled)'}
                      </>
                    }
                    hint={server.description}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Agents"
            subtitle="Reusable subagents this prompt can delegate to, defined once and shared across prompts"
          >
            {(agents ?? []).length === 0 ? (
              <p className="stat-note">
                None registered yet. <Link to="/agents">Add an agent</Link> to give this prompt a reviewer,
                tester, or anything else Claude may delegate to.
              </p>
            ) : (
              <div>
                {(agents ?? []).map((agent) => (
                  <Checkbox
                    key={agent.id}
                    checked={draft.agentIds.includes(agent.id)}
                    onChange={(checked) =>
                      patch({
                        agentIds: checked
                          ? [...draft.agentIds, agent.id]
                          : draft.agentIds.filter((value) => value !== agent.id),
                      })
                    }
                    label={
                      <>
                        <code>{agent.name}</code>
                        {!agent.enabled && ' (disabled)'}
                      </>
                    }
                    hint={agent.description}
                  />
                ))}
              </div>
            )}
          </Card>

          <Card
            title="Environment"
            subtitle="Passed to the Claude process. Use it for tokens the task needs — a GITHUB_TOKEN to merge a PR, for instance."
          >
            <KeyValueEditor value={draft.env} onChange={(env) => patch({ env })} />
            {capabilities && (
              <div style={{ marginTop: 14 }}>
                <p className="stat-note">
                  Also available to every run: {capabilities.globalEnvNames.length > 0 && (
                    <>global env {capabilities.globalEnvNames.map((name) => <code key={name}> {name}</code>)}</>
                  )}
                  {capabilities.forwardedEnvNames.length > 0 && (
                    <> · forwarded from the pod {capabilities.forwardedEnvNames.map((name) => <code key={name}> {name}</code>)}</>
                  )}
                  {capabilities.globalEnvNames.length === 0 && capabilities.forwardedEnvNames.length === 0 &&
                    'nothing — the pod environment is not forwarded unless you allow it with FORWARD_ENV_PREFIXES.'}
                </p>
                <div className="pill-list" style={{ marginTop: 8 }}>
                  {capabilities.tools.map((tool) => (
                    <Badge key={tool.name} tone={tool.available ? 'good' : undefined}>
                      <span className="badge-dot" />
                      {tool.name}
                      {tool.available ? '' : ' missing'}
                    </Badge>
                  ))}
                  {/* Off PATH, so it needs its own badge rather than a row in the list. */}
                  <Badge tone={capabilities.browser.available ? 'good' : undefined}>
                    <span className="badge-dot" />
                    browser
                    {capabilities.browser.available ? '' : ' missing'}
                  </Badge>
                </div>
                {capabilities.browser.available && (
                  <p className="stat-note" style={{ marginTop: 8 }}>
                    Playwright finds it on its own; a run should never call{' '}
                    <code>playwright install</code>. Path: <code>{capabilities.browser.executablePath}</code>
                  </p>
                )}
              </div>
            )}
          </Card>

          <Card title="Workspace">
            <Field
              label="Repository"
              hint="Cloned into the working directory before the first run, then fetched and reset onto the branch before every run after that. Leave empty to manage the checkout from the prompt yourself."
            >
              <input
                type="text"
                value={draft.repoUrl ?? ''}
                onChange={(event) => patch({ repoUrl: event.target.value || null })}
                placeholder="https://github.com/owner/repo.git"
              />
            </Field>
            <Field
              label="Branch, tag or commit"
              hint="Empty means the remote's default branch. A branch is reset onto its remote each run; anything the run wants to keep has to be pushed."
            >
              <input
                type="text"
                value={draft.repoRef ?? ''}
                onChange={(event) => patch({ repoRef: event.target.value || null })}
                placeholder="main"
              />
            </Field>
            <Field
              label="Working directory"
              hint="Where the run starts, and where the repository above is checked out. Leave empty for a managed per-prompt directory on the data volume."
            >
              <input
                type="text"
                value={draft.workingDir ?? ''}
                onChange={(event) => patch({ workingDir: event.target.value || null })}
                placeholder="/data/workspaces/my-repo"
              />
            </Field>
            <Field
              label="CLAUDE.md"
              hint="Written into the working directory before each run. Standing context: conventions, what not to touch."
            >
              <textarea
                value={draft.claudeMd ?? ''}
                onChange={(event) => patch({ claudeMd: event.target.value || null })}
              />
            </Field>
          </Card>
        </div>
      )}

      {tab === 'Schedule' && (
        <div className="stack">
          {isNew ? (
            <Card>
              <p className="muted">Create the prompt first, then add triggers to it.</p>
            </Card>
          ) : (
            <TriggerList
              promptId={id}
              triggers={existing?.triggers ?? []}
              timezone={settings?.timezone ?? 'UTC'}
              onChange={refresh}
            />
          )}

          {existing?.recentRuns && existing.recentRuns.length > 0 && (
            <Card title="Recent runs">
              <table className="table">
                <tbody>
                  {existing.recentRuns.map((run) => (
                    <tr key={run.id}>
                      <td>
                        <Link to={`/runs/${run.id}`}>{formatRelative(run.queuedAt)}</Link>
                        <div className="stat-note">{triggerLabel(run.triggerType)}</div>
                      </td>
                      <td className="num muted">{formatTokens(run.totalTokens)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <StatusBadge status={run.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      )}

      {tab === 'Resume' && (
        <div className="stack">
          <Card
            title="When the quota runs out"
            subtitle="A run stopped by the Claude usage limit is parked, not failed"
          >
            <Checkbox
              checked={draft.autoResume}
              onChange={(autoResume) => patch({ autoResume })}
              label="Resume automatically once tokens are back"
              hint="The resumed run continues the same Claude session, so the model keeps everything it had already worked out."
            />

            <Field
              label="Give up after"
              hint="Number of automatic resumes for one interrupted task before it is left alone."
            >
              <input
                type="number"
                min={0}
                max={100}
                value={draft.maxAutoResumes}
                onChange={(event) => patch({ maxAutoResumes: Number(event.target.value) })}
              />
            </Field>

            <Field
              label="Resume message"
              hint="Sent into the resumed session. Leave empty for the built-in “continue from where you left off”."
            >
              <textarea
                value={draft.resumePrompt ?? ''}
                onChange={(event) => patch({ resumePrompt: event.target.value || null })}
                style={{ minHeight: 70 }}
              />
            </Field>
          </Card>

          <Card
            title="Deciding whether the task is finished"
            subtitle="A task that already completed must not be resumed — this is how KubeClaude tells the difference"
          >
            <Field
              label="Completion check"
              hint={
                draft.completionCheck === 'marker'
                  ? 'Claude is told to print a sentinel line when the task is fully done. If that line is in the output, the task is finished and no resume happens. Cheap and deterministic.'
                  : draft.completionCheck === 'judge'
                    ? 'A second, cheap model reads the transcript and decides whether the work was finished. Costs a small number of tokens per interrupted run.'
                    : draft.completionCheck === 'always'
                      ? 'Every interrupted run is treated as unfinished and resumed.'
                      : 'Interrupted runs are never resumed automatically.'
              }
            >
              <select
                value={draft.completionCheck}
                onChange={(event) => patch({ completionCheck: event.target.value as Draft['completionCheck'] })}
              >
                <option value="marker">Completion marker (recommended)</option>
                <option value="judge">Ask a cheap model to judge</option>
                <option value="always">Always assume unfinished</option>
                <option value="never">Never resume</option>
              </select>
            </Field>

            {draft.completionCheck === 'marker' && (
              <Field
                label="Marker"
                hint="Must appear on a line of its own. Leave empty for KUBECLAUDE_TASK_COMPLETE."
              >
                <input
                  type="text"
                  value={draft.completionMarker ?? ''}
                  onChange={(event) => patch({ completionMarker: event.target.value || null })}
                  placeholder="KUBECLAUDE_TASK_COMPLETE"
                />
              </Field>
            )}

            {draft.completionCheck === 'judge' && (
              <Field label="Judge model" hint="Leave empty for Claude Haiku 4.5.">
                <input
                  type="text"
                  value={draft.judgeModel ?? ''}
                  onChange={(event) => patch({ judgeModel: event.target.value || null })}
                  placeholder="claude-haiku-4-5-20251001"
                />
              </Field>
            )}
          </Card>

          <Card title="Session continuity">
            <Checkbox
              checked={draft.continueSession}
              onChange={(continueSession) => patch({ continueSession })}
              label="Every scheduled run continues the previous session"
              hint="Off by default: each run starts clean. Turn it on for a long-running task that should accumulate context across runs — it grows the context, and the cost, over time."
            />
            {draft.continueSession &&
              contextTokens > 0 &&
              (contextTokens > 200_000 ? (
                <Banner tone="warning">
                  The last run read <strong>{formatTokens(contextTokens)}</strong> of accumulated
                  context before doing any new work, and every turn of the next run pays for that
                  again. Start a fresh session when the task no longer needs the history.
                </Banner>
              ) : (
                <p className="stat-note">
                  The last run carried {formatTokens(contextTokens)} of context. Every turn re-reads
                  it, so this is the floor on what the next run costs.
                </p>
              ))}
            {existing?.lastSessionId && (
              <p className="stat-note">
                Last session: <code>{existing.lastSessionId}</code>
              </p>
            )}
          </Card>
        </div>
      )}

      {tab === 'Advanced' && (
        <div className="stack">
          <Card title="Limits">
            <Field label="Timeout (seconds)" hint="The run is killed after this. Minimum 30.">
              <input
                type="number"
                min={30}
                value={draft.timeoutSeconds}
                onChange={(event) => patch({ timeoutSeconds: Number(event.target.value) })}
              />
            </Field>
            <Field
              label="Maximum turns"
              hint={
                defaultMaxTurns > 0
                  ? `Empty inherits the global default of ${defaultMaxTurns}. Set 0 to run uncapped.`
                  : 'Empty means no limit, because the global default is switched off.'
              }
            >
              <input
                type="number"
                min={0}
                value={draft.maxTurns ?? ''}
                onChange={(event) => patch({ maxTurns: event.target.value ? Number(event.target.value) : null })}
              />
            </Field>
            <Field
              label="Cost ceiling (USD)"
              hint="The CLI stops itself once a run has spent this much, and still reports what it did — unlike the global token ceiling, which kills the process. Empty means no ceiling."
            >
              <input
                type="number"
                min={0}
                step={0.5}
                value={draft.maxBudgetUsd ?? ''}
                onChange={(event) =>
                  patch({ maxBudgetUsd: event.target.value ? Number(event.target.value) : null })
                }
              />
            </Field>
          </Card>

          <Card title="Workspace">
            <Field
              label="Additional directories"
              hint="Absolute paths, one per line. The working directory is already allowed; these are the extra ones — a second checkout, a shared cache — the run may read and write."
            >
              <ListEditor
                value={draft.addDirs}
                onChange={(addDirs) => patch({ addDirs })}
                placeholder={'/data/workspaces/other-repo'}
              />
            </Field>
          </Card>

          <Card title="Extra instructions">
            <Field
              label="Appended system prompt"
              hint="Added to Claude's system prompt for this prompt's runs."
            >
              <textarea
                value={draft.appendSystemPrompt ?? ''}
                onChange={(event) => patch({ appendSystemPrompt: event.target.value || null })}
              />
            </Field>
            <Field
              label="Replacement system prompt"
              hint="Replaces Claude Code's own system prompt outright, rather than adding to it — including everything it says about being an agent with tools. Leave empty unless that is exactly what you want. The environment briefing and the completion marker are still appended after it."
            >
              <textarea
                value={draft.systemPrompt ?? ''}
                onChange={(event) => patch({ systemPrompt: event.target.value || null })}
              />
            </Field>
          </Card>

          <Card title="What the run is made of">
            <Field
              label="Built-in tools"
              hint="Which tools the model is told exist. Every one of them carries its schema in the system prompt of every request, so a shorter set is cheaper on every turn. This is not the allow list: that decides what may run unattended, this decides what is there at all."
            >
              <select
                value={draft.builtinTools === null ? 'all' : draft.builtinTools.length === 0 ? 'none' : 'only'}
                onChange={(event) =>
                  patch({
                    builtinTools:
                      event.target.value === 'all'
                        ? null
                        : event.target.value === 'none'
                          ? []
                          : // "Only these" with nothing in it reads back as "none",
                            // so choosing it seeds a working set to edit down from.
                            (draft.builtinTools?.length ? draft.builtinTools : [...DEFAULT_BUILTIN_TOOLS]),
                  })
                }
              >
                <option value="all">Everything the CLI ships (default)</option>
                <option value="only">Only the ones listed below</option>
                <option value="none">None — no built-in tools at all</option>
              </select>
            </Field>
            {draft.builtinTools !== null && draft.builtinTools.length > 0 && (
              <ListEditor
                value={draft.builtinTools}
                onChange={(builtinTools) => patch({ builtinTools })}
                placeholder={'Bash\nRead\nEdit'}
              />
            )}

            <Field
              label="Custom subagents"
              hint='A JSON object of subagents the run may delegate to, e.g. {"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}}.'
            >
              <textarea
                value={draft.agentsJson ?? ''}
                onChange={(event) => patch({ agentsJson: event.target.value || null })}
                placeholder={'{\n  "reviewer": { "description": "Reviews code", "prompt": "You are a code reviewer" }\n}'}
              />
            </Field>

            <Field
              label="Settings files to read"
              hint="Left alone, the CLI reads the user, project and local settings files — and the project one belongs to whatever repository this prompt clones. Narrow it if the run should only get what KubeClaude hands it."
            >
              <select
                value={draft.settingSources ?? ''}
                onChange={(event) => patch({ settingSources: event.target.value || null })}
              >
                <option value="">CLI default — user, project and local</option>
                <option value="user">user only</option>
                <option value="user,project">user and project</option>
                <option value="project">project only</option>
                <option value="none">none — read no settings files</option>
              </select>
            </Field>
          </Card>

          <Card title="Raw configuration">
            <Field
              label="Inline MCP config"
              hint="A .mcp.json fragment merged after the connections selected above, and winning on a name clash. ${VAR} placeholders are expanded from the run environment."
            >
              <textarea
                value={draft.mcpConfig ?? ''}
                onChange={(event) => patch({ mcpConfig: event.target.value || null })}
                placeholder={'{\n  "mcpServers": {\n    "example": { "type": "sse", "url": "https://…" }\n  }\n}'}
              />
            </Field>
            <Field
              label="Claude settings.json"
              hint="Passed to the CLI with --settings for this prompt's runs."
            >
              <textarea
                value={draft.settingsJson ?? ''}
                onChange={(event) => patch({ settingsJson: event.target.value || null })}
              />
            </Field>
          </Card>
        </div>
      )}

      {message && (
        <div className="toast" onClick={() => setMessage(null)}>
          {message}
        </div>
      )}
    </div>
  );
}
