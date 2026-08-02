import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { activeToken, applyCompletion, type ActiveToken } from './completion';
import type { Prompt } from '../types';

/**
 * The chat box, with the two completions that save actually looking something
 * up: `@` for a file in the working directory, `/` for a prompt you have
 * already written.
 *
 * Everything here is a text insertion. Neither trigger is a command, nothing is
 * interpreted, and what is sent is exactly what is on screen — a chat that
 * silently rewrote your message would be worse than one with no completions at
 * all.
 */

export interface Suggestion {
  /** What is shown, and what a path completion inserts. */
  value: string;
  label: string;
  hint?: string;
  /** What is inserted, when it differs from the label — a prompt's whole text. */
  insert: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Prompt whose working directory `@` looks in. */
  promptId?: string;
  placeholder?: string;
  busy?: boolean;
  submitLabel?: string;
}

const DEBOUNCE_MS = 120;
const MAX_SUGGESTIONS = 8;

export function Composer({ value, onChange, onSubmit, promptId, placeholder, busy, submitLabel }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const prompts = useRef<Prompt[] | null>(null);

  const token = useMemo<ActiveToken | null>(
    () => (dismissed ? null : activeToken(value, caret)),
    [value, caret, dismissed],
  );

  useEffect(() => {
    if (!token) {
      setSuggestions([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        const found = await lookup(token, promptId, prompts).catch(() => []);
        if (!cancelled) {
          setSuggestions(found);
          setHighlighted(0);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, promptId]);

  const open = suggestions.length > 0 && token !== null;

  const accept = useCallback(
    (suggestion: Suggestion) => {
      if (!token) return;
      const applied = applyCompletion(value, token, suggestion.insert);
      onChange(applied.text);
      setSuggestions([]);
      // The caret has to be moved after React has written the new value, or the
      // browser puts it back at the end of the box.
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(applied.caret, applied.caret);
        setCaret(applied.caret);
      });
    },
    [token, value, onChange],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Escape is handled while a trigger is active rather than only while the
    // menu is on screen: the lookup is debounced, so there is a moment where
    // you have asked for suggestions and they have not arrived, and dismissing
    // in that moment must not be followed by the menu opening anyway.
    if (token && event.key === 'Escape') {
      event.preventDefault();
      setDismissed(true);
      setSuggestions([]);
      return;
    }

    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        // Enter takes the highlighted suggestion rather than sending: the menu
        // is open because you asked for it, and sending half a path helps
        // nobody.
        event.preventDefault();
        accept(suggestions[highlighted]!);
        return;
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  };

  const track = (event: { currentTarget: HTMLTextAreaElement }) => {
    setCaret(event.currentTarget.selectionStart);
  };

  return (
    <div className="composer-box">
      {open && (
        <ul className="completions" role="listbox" aria-label="Suggestions">
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.value}>
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                className={index === highlighted ? 'completion selected' : 'completion'}
                // The textarea loses focus on mousedown, which closes the menu
                // before a click can land on it.
                onMouseDown={(event) => {
                  event.preventDefault();
                  accept(suggestion);
                }}
                onMouseEnter={() => setHighlighted(index)}
              >
                <span className="completion-label">{suggestion.label}</span>
                {suggestion.hint && <span className="completion-hint">{suggestion.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
          setCaret(event.target.selectionStart);
        }}
        onKeyUp={track}
        onClick={track}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={3}
      />

      <div className="composer-actions">
        <span className="stat-note">
          Enter sends · Shift+Enter for a new line · <code>@</code> a file · <code>/</code> a saved prompt
        </span>
        <button className="primary" onClick={onSubmit} disabled={!value.trim()}>
          {submitLabel ?? (busy ? 'Queue' : 'Send')}
        </button>
      </div>
    </div>
  );
}

/** What to offer for the token being typed. */
async function lookup(
  token: ActiveToken,
  promptId: string | undefined,
  cache: React.MutableRefObject<Prompt[] | null>,
): Promise<Suggestion[]> {
  if (token.kind === 'path') {
    if (!promptId) return [];
    const { items } = await api.promptFiles(promptId, token.query, MAX_SUGGESTIONS);
    return items.map((item) => ({
      value: item.path,
      label: item.path,
      hint: item.directory ? 'folder' : undefined,
      insert: item.path,
    }));
  }

  // The prompt list is small and changes rarely; fetching it once per composer
  // keeps `/` instant.
  cache.current ??= await api.prompts();
  const needle = token.query.toLowerCase();
  return cache.current
    .filter((prompt) => !needle || prompt.name.toLowerCase().includes(needle))
    .slice(0, MAX_SUGGESTIONS)
    .map((prompt) => ({
      value: prompt.id,
      label: prompt.name,
      hint: firstLine(prompt.prompt),
      insert: prompt.prompt,
    }));
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}
