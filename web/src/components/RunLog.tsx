import { useEffect, useMemo, useRef } from 'react';
import { formatTime } from '../format';
import { asText } from './jsonText';
import type { RunEvent } from '../types';

interface Line {
  key: string;
  ts: string;
  kind: string;
  className: string;
  body: string;
}

/** Turn one stream-json message into the lines a human wants to read. */
function linesFor(event: RunEvent): Line[] {
  const base = { key: `${event.runId}-${event.seq}`, ts: event.ts };

  if (event.kind === 'stderr') {
    const text = (event.payload as { text?: string })?.text ?? '';
    return [{ ...base, kind: 'stderr', className: 'error', body: text }];
  }

  if (event.kind === 'system') {
    const payload = event.payload as Record<string, unknown>;
    if (payload.kind === 'invocation') {
      // An appended system prompt can be pages long; show the shape of the
      // command, not its full text.
      const args = (payload.args as string[])
        .map((arg) => (arg.length > 80 ? `${arg.slice(0, 77)}…` : arg))
        .join(' ');
      return [{ ...base, kind: 'exec', className: 'system', body: `claude ${args}\ncwd: ${payload.cwd}` }];
    }
    return [{ ...base, kind: asText(payload.kind, 'system'), className: 'system', body: summarise(payload) }];
  }

  const message = event.payload as Record<string, unknown>;

  if (message.type === 'system' && message.subtype === 'init') {
    const tools = Array.isArray(message.tools) ? (message.tools as string[]).length : 0;
    const servers = Array.isArray(message.mcp_servers) ? (message.mcp_servers as unknown[]).length : 0;
    return [
      {
        ...base,
        kind: 'init',
        className: 'system',
        body: `session ${asText(message.session_id)} · model ${asText(message.model, '?')} · ${tools} tools · ${servers} MCP servers`,
      },
    ];
  }

  if (message.type === 'assistant' || message.type === 'user') {
    const content = (message.message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return [];
    const out: Line[] = [];
    content.forEach((block, index) => {
      const typed = block as Record<string, unknown>;
      const key = `${base.key}-${index}`;
      if (typed.type === 'text' && typeof typed.text === 'string' && typed.text.trim()) {
        out.push({ ...base, key, kind: message.type as string, className: 'assistant', body: typed.text });
      } else if (typed.type === 'tool_use') {
        out.push({
          ...base,
          key,
          kind: asText(typed.name, 'tool'),
          className: 'tool',
          body: preview(typed.input),
        });
      } else if (typed.type === 'tool_result') {
        out.push({
          ...base,
          key,
          kind: 'result',
          className: typed.is_error ? 'error' : '',
          body: preview(typed.content),
        });
      } else if (typed.type === 'thinking') {
        out.push({ ...base, key, kind: 'thinking', className: '', body: asText(typed.thinking) });
      }
    });
    return out;
  }

  if (message.type === 'result') {
    const usage = (message.usage ?? {}) as Record<string, number>;
    return [
      {
        ...base,
        kind: 'done',
        className: message.is_error ? 'error' : 'system',
        body:
          `${asText(message.subtype)} · ${asText(message.num_turns, '0')} turns · ` +
          `in ${usage.input_tokens ?? 0} / out ${usage.output_tokens ?? 0} / ` +
          `cache ${(usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)} tokens` +
          (typeof message.result === 'string' ? `\n\n${message.result}` : ''),
      },
    ];
  }

  return [];
}

function summarise(payload: Record<string, unknown>): string {
  return Object.entries(payload)
    .filter(([key]) => key !== 'kind')
    .map(([key, value]) => `${key}: ${asText(value)}`)
    .join('\n');
}

function preview(value: unknown, max = 1200): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  const text = JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function RunLog({ events, follow }: { events: RunEvent[]; follow: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => events.flatMap(linesFor), [events]);

  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines.length, follow]);

  if (lines.length === 0) {
    return <div className="empty">No output yet.</div>;
  }

  return (
    <div className="log" ref={ref}>
      {lines.map((line) => (
        <div className={`log-line ${line.className}`} key={line.key}>
          <span className="log-time">{formatTime(line.ts)}</span>
          <span className="log-kind">{line.kind}</span>
          <span className="log-body">{line.body}</span>
        </div>
      ))}
    </div>
  );
}
