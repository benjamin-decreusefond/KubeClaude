import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ChatTranscript } from '../components/ChatTranscript';
import { Composer } from '../components/Composer';
import { Banner, Modal, Field } from '../components/primitives';
import { useStream } from '../hooks';
import type { ChatDetail, Run, RunEvent } from '../types';

export function Chat() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Map<string, RunEvent[]>>(new Map());
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [promoting, setPromoting] = useState(false);
  /** Held while a turn is in flight; sent as soon as it finishes. */
  const [queued, setQueued] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    const detail = await api.chat(id);
    setChat(detail);
    const pages = await Promise.all(detail.runs.map((run) => api.runEvents(run.id)));
    setEventsByRun(new Map(detail.runs.map((run, index) => [run.id, pages[index]!.events])));
  }, [id]);

  useEffect(() => {
    setChat(null);
    setEventsByRun(new Map());
    void load().catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [load]);

  const runIds = new Set((chat?.runs ?? []).map((run) => run.id));

  useStream((event, payload) => {
    if (event === 'run:event') {
      const runEvent = payload as RunEvent;
      if (!runIds.has(runEvent.runId)) return;
      setEventsByRun((current) => {
        const next = new Map(current);
        const existing = next.get(runEvent.runId) ?? [];
        if (existing.some((e) => e.seq === runEvent.seq)) return current;
        next.set(runEvent.runId, [...existing, runEvent]);
        return next;
      });
    } else if (event === 'run:created') {
      const run = payload as Run;
      if (run.promptId === id) void load();
    } else if (event === 'run:updated') {
      const run = payload as Run;
      if (run.promptId !== id) return;
      setChat((current) =>
        current
          ? {
              ...current,
              runs: current.runs.map((existing) => (existing.id === run.id ? run : existing)),
              busy: run.status === 'queued' || run.status === 'running',
            }
          : current,
      );
    }
  });

  const send = useCallback(
    async (text: string) => {
      if (!id || !text.trim()) return;
      setError(null);
      try {
        await api.sendChatMessage(id, text.trim());
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setDraft(text);
      }
    },
    [id, load],
  );

  // A turn cannot take input while it runs, so a message typed meanwhile is
  // held here and sent the moment Claude finishes.
  useEffect(() => {
    if (!chat?.busy && queued) {
      const pending = queued;
      setQueued(null);
      void send(pending);
    }
  }, [chat?.busy, queued, send]);

  const stop = async () => {
    await api.stopChat(chat!.id).catch(() => undefined);
    await load();
  };

  const remove = async () => {
    if (!confirm('Delete this conversation?')) return;
    await api.deleteChat(chat!.id);
    navigate('/chats');
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    if (chat?.busy) setQueued(text);
    else void send(text);
  };

  if (!chat) {
    return (
      <div>
        <h1>Chat</h1>
        <p className="muted" style={{ marginTop: 8 }}>{error ?? 'Loading…'}</p>
      </div>
    );
  }

  return (
    <div className="chat-page">
      <header className="chat-head">
        <div style={{ minWidth: 0 }}>
          <h1 title={chat.title ?? ''}>{chat.title ?? 'Chat'}</h1>
          <p className="stat-note">
            {chat.model ?? 'account default'} · {chat.permissionMode}
            {chat.mcpServerIds.length > 0 ? ` · ${chat.mcpServerIds.length} MCP` : ''}
            {chat.workingDir ? ` · ${chat.workingDir}` : ''}
          </p>
        </div>
        <div className="row">
          {chat.busy && (
            <button className="danger small" onClick={() => void stop()}>
              Stop
            </button>
          )}
          <button className="ghost small" onClick={() => setPromoting(true)}>
            Save as prompt
          </button>
          <button className="ghost small" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </header>

      {error && <Banner tone="critical">{error}</Banner>}

      <ChatTranscript runs={chat.runs} eventsByRun={eventsByRun} busy={chat.busy} />

      <div className="composer">
        {queued && (
          <div className="composer-queued">
            Queued — will send as soon as Claude finishes:{' '}
            <span className="muted">{queued.slice(0, 90)}</span>
            <button className="ghost small" onClick={() => setQueued(null)}>
              Cancel
            </button>
          </div>
        )}
        <Composer
          value={draft}
          onChange={setDraft}
          onSubmit={submit}
          promptId={chat.id}
          busy={chat.busy}
          placeholder={
            chat.busy
              ? 'Claude is working — type ahead and this will send when it finishes'
              : 'Reply to Claude…  (Enter to send, Shift+Enter for a new line)'
          }
        />
      </div>

      {promoting && <PromoteModal chat={chat} onClose={() => setPromoting(false)} />}
    </div>
  );
}

/** Turn a conversation that worked into something that runs on a schedule. */
function PromoteModal({ chat, onClose }: { chat: ChatDetail; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(chat.title ?? '');
  const [prompt, setPrompt] = useState(chat.runs[0]?.promptText ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const promote = async () => {
    setSaving(true);
    setError(null);
    try {
      const created = await api.promoteChat(chat.id, name.trim(), prompt.trim());
      navigate(`/prompts/${created.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Save as a scheduled prompt"
      onClose={onClose}
      footer={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={saving || !name.trim() || !prompt.trim()}
            onClick={() => void promote()}
          >
            {saving ? 'Saving…' : 'Create prompt'}
          </button>
        </>
      }
    >
      {error && <Banner tone="critical">{error}</Banner>}
      <p className="secondary" style={{ marginBottom: 14 }}>
        Keeps this conversation's model, tools and MCP connections, and switches the resume policy back to
        the one that suits unattended runs. Add a trigger afterwards to put it on a schedule.
      </p>
      <Field label="Name">
        <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field
        label="Prompt"
        hint="Written as a standalone task — a scheduled run has none of this conversation's context."
      >
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} style={{ minHeight: 160 }} />
      </Field>
    </Modal>
  );
}
