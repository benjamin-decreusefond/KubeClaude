import { randomUUID } from 'node:crypto';
import { boolFromDb, boolToDb, db, jsonFromDb } from '../db.js';
import type { CompletionCheck, Effort, PermissionMode, Prompt, PromptKind } from '../types.js';

interface PromptRow {
  id: string;
  kind: string;
  name: string;
  title: string | null;
  description: string;
  prompt: string;
  enabled: number;
  model: string | null;
  fallback_model: string | null;
  effort: string | null;
  max_budget_usd: number | null;
  working_dir: string | null;
  add_dirs: string;
  repo_url: string | null;
  repo_ref: string | null;
  permission_mode: string;
  allowed_tools: string;
  disallowed_tools: string;
  append_system_prompt: string | null;
  system_prompt: string | null;
  agents_json: string | null;
  builtin_tools: string | null;
  setting_sources: string | null;
  max_turns: number | null;
  timeout_seconds: number;
  env: string;
  mcp_config: string | null;
  mcp_server_ids: string;
  settings_json: string | null;
  claude_md: string | null;
  continue_session: number;
  last_session_id: string | null;
  auto_resume: number;
  max_auto_resumes: number;
  resume_prompt: string | null;
  completion_check: string;
  completion_marker: string | null;
  judge_model: string | null;
  created_at: string;
  updated_at: string;
}

function toPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    kind: row.kind as PromptKind,
    name: row.name,
    title: row.title,
    description: row.description,
    prompt: row.prompt,
    enabled: boolFromDb(row.enabled),
    model: row.model,
    fallbackModel: row.fallback_model,
    effort: (row.effort as Effort | null) || null,
    maxBudgetUsd: row.max_budget_usd,
    workingDir: row.working_dir,
    addDirs: jsonFromDb<string[]>(row.add_dirs, []),
    repoUrl: row.repo_url,
    repoRef: row.repo_ref,
    permissionMode: row.permission_mode as PermissionMode,
    allowedTools: jsonFromDb<string[]>(row.allowed_tools, []),
    disallowedTools: jsonFromDb<string[]>(row.disallowed_tools, []),
    appendSystemPrompt: row.append_system_prompt,
    systemPrompt: row.system_prompt,
    agentsJson: row.agents_json,
    // An absent column and a stored empty list mean different things here, so
    // the fallback is null rather than [].
    builtinTools: row.builtin_tools === null ? null : jsonFromDb<string[] | null>(row.builtin_tools, null),
    settingSources: row.setting_sources,
    maxTurns: row.max_turns,
    timeoutSeconds: row.timeout_seconds,
    env: jsonFromDb<Record<string, string>>(row.env, {}),
    mcpConfig: row.mcp_config,
    mcpServerIds: jsonFromDb<string[]>(row.mcp_server_ids, []),
    settingsJson: row.settings_json,
    claudeMd: row.claude_md,
    continueSession: boolFromDb(row.continue_session),
    lastSessionId: row.last_session_id,
    autoResume: boolFromDb(row.auto_resume),
    maxAutoResumes: row.max_auto_resumes,
    resumePrompt: row.resume_prompt,
    completionCheck: row.completion_check as CompletionCheck,
    completionMarker: row.completion_marker,
    judgeModel: row.judge_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type PromptInput = Omit<Prompt, 'id' | 'createdAt' | 'updatedAt' | 'lastSessionId'>;

/** Scheduled prompts only; chats have their own listing. */
export function listPrompts(): Prompt[] {
  return db
    .prepare<[], PromptRow>("SELECT * FROM prompts WHERE kind = 'scheduled' ORDER BY name COLLATE NOCASE")
    .all()
    .map(toPrompt);
}

/** Conversations, most recently touched first. */
export function listChats(limit = 100): Prompt[] {
  return db
    .prepare<[number], PromptRow>(
      "SELECT * FROM prompts WHERE kind = 'chat' ORDER BY updated_at DESC LIMIT ?",
    )
    .all(limit)
    .map(toPrompt);
}

/** Names are unique across every kind, so a caller picking one has to ask. */
export function promptNameExists(name: string): boolean {
  const row = db
    .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM prompts WHERE name = ?')
    .get(name);
  return (row?.count ?? 0) > 0;
}

export function getPrompt(id: string): Prompt | null {
  const row = db.prepare<[string], PromptRow>('SELECT * FROM prompts WHERE id = ?').get(id);
  return row ? toPrompt(row) : null;
}

export function createPrompt(input: PromptInput): Prompt {
  const now = new Date().toISOString();
  const id = randomUUID();
  db.prepare(
    `INSERT INTO prompts (
       id, kind, title, name, description, prompt, enabled, model, fallback_model, effort, max_budget_usd,
       working_dir, add_dirs, repo_url, repo_ref, permission_mode,
       allowed_tools, disallowed_tools, append_system_prompt, system_prompt, agents_json,
       builtin_tools, setting_sources, max_turns, timeout_seconds,
       env, mcp_config, mcp_server_ids, settings_json, claude_md, continue_session, last_session_id,
       auto_resume, max_auto_resumes, resume_prompt, completion_check, completion_marker,
       judge_model, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.title,
    input.name,
    input.description,
    input.prompt,
    boolToDb(input.enabled),
    input.model,
    input.fallbackModel,
    input.effort,
    input.maxBudgetUsd,
    input.workingDir,
    // Coalesced rather than trusted: the column is NOT NULL, and a caller
    // written before it existed would otherwise fail the insert instead of
    // getting the empty list the migration promises.
    JSON.stringify(input.addDirs ?? []),
    input.repoUrl,
    input.repoRef,
    input.permissionMode,
    JSON.stringify(input.allowedTools),
    JSON.stringify(input.disallowedTools),
    input.appendSystemPrompt,
    input.systemPrompt ?? null,
    input.agentsJson ?? null,
    input.builtinTools == null ? null : JSON.stringify(input.builtinTools),
    input.settingSources ?? null,
    input.maxTurns,
    input.timeoutSeconds,
    JSON.stringify(input.env),
    input.mcpConfig,
    JSON.stringify(input.mcpServerIds),
    input.settingsJson,
    input.claudeMd,
    boolToDb(input.continueSession),
    boolToDb(input.autoResume),
    input.maxAutoResumes,
    input.resumePrompt,
    input.completionCheck,
    input.completionMarker,
    input.judgeModel,
    now,
    now,
  );
  return getPrompt(id)!;
}

const COLUMN_BY_FIELD: Record<string, string> = {
  kind: 'kind',
  title: 'title',
  name: 'name',
  description: 'description',
  prompt: 'prompt',
  enabled: 'enabled',
  model: 'model',
  fallbackModel: 'fallback_model',
  effort: 'effort',
  maxBudgetUsd: 'max_budget_usd',
  workingDir: 'working_dir',
  addDirs: 'add_dirs',
  repoUrl: 'repo_url',
  repoRef: 'repo_ref',
  permissionMode: 'permission_mode',
  allowedTools: 'allowed_tools',
  disallowedTools: 'disallowed_tools',
  appendSystemPrompt: 'append_system_prompt',
  systemPrompt: 'system_prompt',
  agentsJson: 'agents_json',
  builtinTools: 'builtin_tools',
  settingSources: 'setting_sources',
  maxTurns: 'max_turns',
  timeoutSeconds: 'timeout_seconds',
  env: 'env',
  mcpConfig: 'mcp_config',
  mcpServerIds: 'mcp_server_ids',
  settingsJson: 'settings_json',
  claudeMd: 'claude_md',
  continueSession: 'continue_session',
  lastSessionId: 'last_session_id',
  autoResume: 'auto_resume',
  maxAutoResumes: 'max_auto_resumes',
  resumePrompt: 'resume_prompt',
  completionCheck: 'completion_check',
  completionMarker: 'completion_marker',
  judgeModel: 'judge_model',
};

const JSON_FIELDS = new Set([
  'allowedTools',
  'disallowedTools',
  'env',
  'mcpServerIds',
  'addDirs',
  // Nullable: JSON.stringify(null) round-trips back to null, which is what
  // "leave the built-in tools alone" has to keep meaning after an edit.
  'builtinTools',
]);
const BOOL_FIELDS = new Set(['enabled', 'continueSession', 'autoResume']);

export function updatePrompt(id: string, patch: Partial<Prompt>): Prompt | null {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [field, value] of Object.entries(patch)) {
    const column = COLUMN_BY_FIELD[field];
    if (!column || value === undefined) continue;
    assignments.push(`${column} = ?`);
    if (JSON_FIELDS.has(field)) values.push(JSON.stringify(value));
    else if (BOOL_FIELDS.has(field)) values.push(boolToDb(Boolean(value)));
    else values.push(value);
  }

  if (assignments.length === 0) return getPrompt(id);

  assignments.push('updated_at = ?');
  values.push(new Date().toISOString(), id);
  db.prepare(`UPDATE prompts SET ${assignments.join(', ')} WHERE id = ?`).run(...(values as never[]));
  return getPrompt(id);
}

export function deletePrompt(id: string): boolean {
  return db.prepare('DELETE FROM prompts WHERE id = ?').run(id).changes > 0;
}
