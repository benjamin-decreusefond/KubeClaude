import { cloneElement, isValidElement, useId, type ReactNode } from 'react';
import type { RunStatus } from '../types';

export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card${className ? ` ${className}` : ''}`}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {subtitle && <div className="card-sub">{subtitle}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  note,
  hero,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  hero?: boolean;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${hero ? ' hero' : ''}`}>{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

/**
 * A single ratio against a limit. The track and fill come from the same
 * sequential ramp, so it reads as "how much of one thing".
 */
export function Meter({
  value,
  max,
  leftLabel,
  rightLabel,
  tone = 'default',
}: {
  value: number;
  max: number;
  leftLabel?: ReactNode;
  rightLabel?: ReactNode;
  tone?: 'default' | 'warning' | 'critical';
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const fill =
    tone === 'critical' ? 'var(--status-critical)' : tone === 'warning' ? 'var(--status-warning)' : undefined;
  return (
    <div>
      <div
        className="meter"
        role="meter"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="meter-fill" style={{ width: `${pct}%`, background: fill }} />
      </div>
      {(leftLabel || rightLabel) && (
        <div className="meter-legend">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<RunStatus, string> = {
  queued: '',
  running: 'running',
  succeeded: 'good',
  failed: 'critical',
  cancelled: '',
  timeout: 'serious',
  skipped: '',
  rate_limited: 'warning',
  // Not `critical`: a ceiling was reached, which is a setting to revisit rather
  // than a fault to investigate.
  capped: 'warning',
};

const STATUS_LABEL: Record<RunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  skipped: 'Skipped',
  rate_limited: 'Quota reached',
  capped: 'Limit reached',
};

/** Status always ships as a dot plus a word — never colour alone. */
export function StatusBadge({ status }: { status: RunStatus }) {
  return (
    <span className={`badge ${STATUS_TONE[status]}`}>
      <span className="badge-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}`}>{children}</span>;
}

/**
 * A labelled control. The label is wired to the control it names — clicking it
 * focuses the field, and a screen reader announces the two together — by handing
 * the child an id when it does not already carry one. Doing it here rather than
 * at every call site is what keeps it true for all of them.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const generatedId = useId();
  const hintId = `${generatedId}-hint`;

  const child = isValidElement<{ id?: string; 'aria-describedby'?: string }>(children) ? children : null;
  const controlId = child?.props.id ?? generatedId;
  const control = child
    ? cloneElement(child, {
        id: controlId,
        'aria-describedby': hint ? hintId : child.props['aria-describedby'],
      })
    : children;

  return (
    <div className="field">
      <label htmlFor={controlId}>{label}</label>
      {control}
      {hint && (
        <div className="hint" id={hintId}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>
        {label}
        {hint && (
          <>
            <br />
            <span className="hint">{hint}</span>
          </>
        )}
      </span>
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div className="modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="ghost small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {children}
        {footer && (
          <footer className="row" style={{ justifyContent: 'flex-end', marginTop: 18 }}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}

export function Banner({
  tone = 'warning',
  icon = '!',
  children,
}: {
  tone?: 'warning' | 'critical';
  icon?: string;
  children: ReactNode;
}) {
  return (
    <div className={`banner ${tone}`}>
      <span className="banner-icon" aria-hidden>
        {icon}
      </span>
      <div>{children}</div>
    </div>
  );
}
