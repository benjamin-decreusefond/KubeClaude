import type {
  Capabilities,
  ChatDetail,
  ChatSummary,
  CreateGoalInput,
  Dashboard,
  Goal,
  GoalDetail,
  StartChatInput,
  UpdateGoalInput,
  McpServer,
  ModelOption,
  Prompt,
  Run,
  RunEvent,
  Settings,
  Status,
  Trigger,
  TriggerConfig,
  TriggerType,
  ToolPreset,
  UsageWindow,
} from './types';

/**
 * When the server is started with KUBECLAUDE_AUTH_TOKEN, the UI needs it too.
 * It is kept in localStorage and sent as a bearer token, or as ?token= on the
 * SSE endpoint, which cannot carry headers.
 */
const TOKEN_KEY = 'kubeclaude.token';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(path, { ...init, headers });
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const record = body as { error?: string; details?: unknown } | null;
    throw new ApiError(record?.error ?? `Request failed (${response.status})`, response.status, record?.details);
  }
  return body as T;
}

export const api = {
  status: () => request<Status>('/api/status'),
  capabilities: () => request<Capabilities>('/api/capabilities'),
  models: () => request<{ models: ModelOption[] }>('/api/models'),
  toolPresets: () => request<{ presets: ToolPreset[] }>('/api/tool-presets'),
  dashboard: () => request<Dashboard>('/api/dashboard'),
  usage: () =>
    request<{ sessionWindows: UsageWindow[]; weeklyWindows: UsageWindow[] }>('/api/usage'),

  settings: () => request<Settings>('/api/settings'),
  settingsDefaults: () => request<Settings>('/api/settings/defaults'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  prompts: () => request<Prompt[]>('/api/prompts'),
  prompt: (id: string) => request<Prompt>(`/api/prompts/${id}`),
  createPrompt: (input: Partial<Prompt>) =>
    request<Prompt>('/api/prompts', { method: 'POST', body: JSON.stringify(input) }),
  updatePrompt: (id: string, patch: Partial<Prompt>) =>
    request<Prompt>(`/api/prompts/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePrompt: (id: string) => request<void>(`/api/prompts/${id}`, { method: 'DELETE' }),
  runPrompt: (id: string, promptText?: string) =>
    request<Run>(`/api/prompts/${id}/run`, {
      method: 'POST',
      body: JSON.stringify(promptText ? { promptText } : {}),
    }),

  createTrigger: (
    promptId: string,
    input: { type: TriggerType; enabled: boolean; cronExpression: string | null; timezone: string; config: TriggerConfig },
  ) => request<Trigger>(`/api/prompts/${promptId}/triggers`, { method: 'POST', body: JSON.stringify(input) }),
  updateTrigger: (id: string, patch: Partial<Trigger>) =>
    request<Trigger>(`/api/triggers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteTrigger: (id: string) => request<void>(`/api/triggers/${id}`, { method: 'DELETE' }),
  fireTrigger: (id: string) => request<Run>(`/api/triggers/${id}/fire`, { method: 'POST' }),
  previewCron: (expression: string, timezone: string) =>
    request<{ valid: boolean; next: string[]; error?: string }>('/api/cron/preview', {
      method: 'POST',
      body: JSON.stringify({ expression, timezone }),
    }),

  runs: (params: { promptId?: string; status?: string; limit?: number; offset?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    return request<{ items: Run[]; total: number }>(`/api/runs?${query.toString()}`);
  },
  run: (id: string) => request<Run>(`/api/runs/${id}`),
  runEvents: (id: string, after = 0) =>
    request<{ events: RunEvent[] }>(`/api/runs/${id}/events?after=${after}`),
  runThread: (id: string) => request<{ runs: Run[] }>(`/api/runs/${id}/thread`),
  cancelRun: (id: string) => request<Run>(`/api/runs/${id}/cancel`, { method: 'POST' }),
  resumeRun: (id: string) => request<Run>(`/api/runs/${id}/resume`, { method: 'POST' }),
  followUp: (id: string, message: string) =>
    request<Run>(`/api/runs/${id}/follow-up`, { method: 'POST', body: JSON.stringify({ message }) }),

  chats: () => request<ChatSummary[]>('/api/chats'),
  chat: (id: string) => request<ChatDetail>(`/api/chats/${id}`),
  startChat: (input: StartChatInput) =>
    request<ChatDetail>('/api/chats', { method: 'POST', body: JSON.stringify(input) }),
  sendChatMessage: (id: string, message: string) =>
    request<Run>(`/api/chats/${id}/messages`, { method: 'POST', body: JSON.stringify({ message }) }),
  stopChat: (id: string) => request<Run>(`/api/chats/${id}/stop`, { method: 'POST' }),
  renameChat: (id: string, title: string) =>
    request<Prompt>(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChat: (id: string) => request<void>(`/api/chats/${id}`, { method: 'DELETE' }),
  promoteChat: (id: string, name: string, prompt: string) =>
    request<Prompt>(`/api/chats/${id}/promote`, {
      method: 'POST',
      body: JSON.stringify({ name, prompt }),
    }),

  goals: () => request<Goal[]>('/api/goals'),
  goal: (id: string) => request<GoalDetail>(`/api/goals/${id}`),
  createGoal: (input: Partial<CreateGoalInput>) =>
    request<GoalDetail>('/api/goals', { method: 'POST', body: JSON.stringify(input) }),
  updateGoal: (id: string, patch: UpdateGoalInput) =>
    request<Goal>(`/api/goals/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteGoal: (id: string) => request<void>(`/api/goals/${id}`, { method: 'DELETE' }),
  startGoal: (id: string) => request<Goal>(`/api/goals/${id}/start`, { method: 'POST' }),
  pauseGoal: (id: string) => request<Goal>(`/api/goals/${id}/pause`, { method: 'POST' }),
  iterateGoal: (id: string) => request<Run>(`/api/goals/${id}/iterate`, { method: 'POST' }),

  mcpServers: () => request<McpServer[]>('/api/mcp-servers'),
  createMcpServer: (input: Partial<McpServer>) =>
    request<McpServer>('/api/mcp-servers', { method: 'POST', body: JSON.stringify(input) }),
  updateMcpServer: (id: string, patch: Partial<McpServer>) =>
    request<McpServer>(`/api/mcp-servers/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMcpServer: (id: string) => request<void>(`/api/mcp-servers/${id}`, { method: 'DELETE' }),
  previewMcp: (serverIds: string[], inlineConfig: string | null) =>
    request<{ document: string | null }>('/api/mcp-servers/preview', {
      method: 'POST',
      body: JSON.stringify({ serverIds, inlineConfig }),
    }),
};

export function streamUrl(runId?: string): string {
  const params = new URLSearchParams();
  if (runId) params.set('runId', runId);
  const token = getToken();
  if (token) params.set('token', token);
  const query = params.toString();
  return `/api/stream${query ? `?${query}` : ''}`;
}
