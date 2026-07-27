import { useState } from 'react';

/**
 * Editor for env-style maps. Values are stored as written, so `${VAR}` style
 * placeholders survive to the run — that is how a secret reaches Claude without
 * being typed in here.
 */
export function KeyValueEditor({
  value,
  onChange,
  keyPlaceholder = 'NAME',
  valuePlaceholder = 'value',
}: {
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const entries = Object.entries(value);

  const add = () => {
    const key = newKey.trim();
    if (!key) return;
    onChange({ ...value, [key]: newValue });
    setNewKey('');
    setNewValue('');
  };

  return (
    <div>
      {entries.map(([key, entryValue]) => (
        <div className="row" key={key} style={{ marginBottom: 6, flexWrap: 'nowrap' }}>
          <input type="text" value={key} readOnly style={{ flex: '0 0 40%', fontFamily: 'var(--font-mono)' }} />
          <input
            type="text"
            value={entryValue}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
          />
          <button
            className="ghost small"
            type="button"
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
            aria-label={`Remove ${key}`}
          >
            ✕
          </button>
        </div>
      ))}

      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          type="text"
          value={newKey}
          placeholder={keyPlaceholder}
          onChange={(event) => setNewKey(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), add())}
          style={{ flex: '0 0 40%', fontFamily: 'var(--font-mono)' }}
        />
        <input
          type="text"
          value={newValue}
          placeholder={valuePlaceholder}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && (event.preventDefault(), add())}
          style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
        />
        <button className="small" type="button" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

/** Comma or newline separated list, kept as an array. */
export function ListEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <textarea
      value={value.join('\n')}
      placeholder={placeholder}
      onChange={(event) =>
        onChange(
          event.target.value
            .split(/[\n,]/)
            .map((item) => item.trim())
            .filter(Boolean),
        )
      }
      style={{ minHeight: 72 }}
    />
  );
}
