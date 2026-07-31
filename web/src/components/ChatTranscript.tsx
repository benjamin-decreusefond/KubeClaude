import { useEffect, useMemo, useRef, useState } from 'react';
import { formatCost, formatTime, formatTokens } from '../format';
import { asText } from './jsonText';
import type { Run, RunEvent } from '../types';

/** One thing to show in the conversation. */
type Bubble =
  | { kind: 'user'; key: string; ts: string; text: string }
  | { kind: 'assistant'; key: string; ts: string; text: string }
  | { kind: 'thinking'; key: string; ts: string; text: string }
  | { kind: 'tool'; key: string; ts: string; name: string; input: string; result?: string; isError?: boolean }
  | { kind: 'notice'; key: string; ts: string; text: string; tone: 'error' | 'muted' }
  | { kind: 'turn'; key: string; ts: string; run: Run };

function preview(value: unknown, max = 4000): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text;
}

/**
 * Fold the raw stream into a conversation. Tool calls are paired with their
 * results so a turn reads as "did X, got Y" instead of interleaved JSON.
 */
export function buildBubbles(runs: Run[], eventsByRun: Map<string, RunEvent[]>): Bubble[] {
  const bubbles: Bubble[] = [];

  for (const run of runs) {
    bubbles.push({
      kind: 'user',
      key: `${run.id}-prompt`,
      ts: run.queuedAt,
      text: run.followUpText ?? run.promptText,
    });

    const pendingTools = new Map<string, Extract<Bubble, { kind: 'tool' }>>();

    for (const event of eventsByRun.get(run.id) ?? []) {
      if (event.kind === 'stderr') continue;

      if (event.kind === 'system') {
        const payload = event.payload as Record<string, unknown>;
        if (payload.kind === 'error' || payload.kind === 'rate-limited') {
          bubbles.push({
            kind: 'notice',
            key: `${run.id}-${event.seq}`,
            ts: event.ts,
            tone: 'error',
            text:
              payload.kind === 'rate-limited'
                ? 'The Claude quota ran out during this reply.'
                : asText(payload.message, 'Something went wrong'),
          });
        }
        continue;
      }

      const message = event.payload as Record<string, unknown>;
      if (message.type !== 'assistant' && message.type !== 'user') continue;
      const content = (message.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) continue;

      content.forEach((block, index) => {
        const typed = block as Record<string, unknown>;
        const key = `${run.id}-${event.seq}-${index}`;

        if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
          bubbles.push({ kind: 'assistant', key, ts: event.ts, text: typed.text });
        } else if (typed.type === 'thinking' && typeof typed.thinking === 'string') {
          bubbles.push({ kind: 'thinking', key, ts: event.ts, text: typed.thinking });
        } else if (typed.type === 'tool_use') {
          const bubble: Extract<Bubble, { kind: 'tool' }> = {
            kind: 'tool',
            key,
            ts: event.ts,
            name: asText(typed.name, 'tool'),
            input: preview(typed.input),
          };
          if (typeof typed.id === 'string') pendingTools.set(typed.id, bubble);
          bubbles.push(bubble);
        } else if (typed.type === 'tool_result') {
          const target = typeof typed.tool_use_id === 'string' ? pendingTools.get(typed.tool_use_id) : undefined;
          if (target) {
            target.result = preview(typed.content);
            target.isError = typed.is_error === true;
          }
        }
      });
    }

    if (run.status !== 'queued' && run.status !== 'running') {
      bubbles.push({ kind: 'turn', key: `${run.id}-turn`, ts: run.finishedAt ?? run.queuedAt, run });
    }
  }

  return bubbles;
}

export function ChatTranscript({
  runs,
  eventsByRun,
  busy,
}: {
  runs: Run[];
  eventsByRun: Map<string, RunEvent[]>;
  busy: boolean;
}) {
  const bubbles = useMemo(() => buildBubbles(runs, eventsByRun), [runs, eventsByRun]);
  const endRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the tail unless the reader has scrolled up to read something.
  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [bubbles.length, busy, pinned]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  };

  return (
    <div className="chat-scroll" onScroll={onScroll}>
      {bubbles.map((bubble) => (
        <ChatBubble key={bubble.key} bubble={bubble} />
      ))}
      {busy && (
        <div className="chat-msg assistant">
          <div className="chat-role">Claude</div>
          <div className="chat-body working">
            <span className="spinner" /> working…
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function ChatBubble({ bubble }: { bubble: Bubble }) {
  const [open, setOpen] = useState(false);

  if (bubble.kind === 'user') {
    return (
      <div className="chat-msg user">
        <div className="chat-role">You</div>
        <div className="chat-body">{bubble.text}</div>
      </div>
    );
  }

  if (bubble.kind === 'assistant') {
    return (
      <div className="chat-msg assistant">
        <div className="chat-role">Claude</div>
        <div className="chat-body">{bubble.text}</div>
      </div>
    );
  }

  if (bubble.kind === 'thinking') {
    return (
      <details className="chat-tool">
        <summary>Thinking</summary>
        <pre className="chat-pre">{bubble.text}</pre>
      </details>
    );
  }

  if (bubble.kind === 'tool') {
    return (
      <details className={`chat-tool${bubble.isError ? ' error' : ''}`} open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span className="chat-tool-name">{bubble.name}</span>
          {bubble.isError && <span className="badge critical">failed</span>}
          <span className="chat-tool-time">{formatTime(bubble.ts)}</span>
        </summary>
        <pre className="chat-pre">{bubble.input}</pre>
        {bubble.result !== undefined && (
          <>
            <div className="chat-tool-label">Result</div>
            <pre className="chat-pre">{bubble.result}</pre>
          </>
        )}
      </details>
    );
  }

  if (bubble.kind === 'notice') {
    return <div className={`chat-notice ${bubble.tone}`}>{bubble.text}</div>;
  }

  const { run } = bubble;
  return (
    <div className="chat-turn-meta">
      {formatTokens(run.totalTokens)} tokens · {formatCost(run.costUsd)}
      {run.numTurns !== null ? ` · ${run.numTurns} turns` : ''}
      {run.status !== 'succeeded' ? ` · ${run.status}` : ''}
      {' · '}
      <a href={`/runs/${run.id}`}>full log</a>
    </div>
  );
}
