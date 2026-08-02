import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, describeError } from '../api';
import { KeyValueEditor, ListEditor } from '../components/KeyValueEditor';
import { Badge, Banner, Card, Checkbox, Field, StatusBadge } from '../components/primitives';
import { formatRelative, formatTokens, triggerLabel } from '../format';
import { usePolled } from '../hooks';
import { TriggerList } from './TriggerEditor';
import type { Capabilities, McpServer, ModelOption, Prompt, Settings, ToolPreset } from '../types';

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
  workingDir: null,
  repoUrl: null,
  repoRef: null,
  permissionMode: 'default',
  allowedTools: [],
  disallowedTools: [],
  appendSystemPrompt: null,
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
                <option value="bypassPermissions">bypassPermissions — no prompts at all</option>
              </select>
            </Field>

            <Field
              label="Start from a preset"
              hint="Every tool Claude can reach carries its schema in the system prompt of every request, so a shorter list is cheaper on every turn. Picking one fills the lists below; edit them freely afterwards."
            >
              <select
                value=""
                onChange={(event) => {
                  const preset = presets.find((entry) => entry.id === event.target.value);
                  if (preset) {
                    patch({
                      allowedTools: preset.allowedTools,
                      disallowedTools: preset.disallowedTools,
                    });
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
                </div>
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
