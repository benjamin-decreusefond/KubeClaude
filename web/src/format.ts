export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined).format(Math.round(value));
}

/** Compact token counts: 1.2M, 48.3k, 912. */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return formatNumber(value);
}

export function formatCost(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(value < 100 ? 2 : 0)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** "in 2h 14m" / "3m ago" — the reader mostly wants the distance, not the clock. */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return '—';

  const deltaMs = target - now;
  const future = deltaMs > 0;
  const seconds = Math.round(Math.abs(deltaMs) / 1000);

  const render = (): string => {
    if (seconds < 45) return `${seconds}s`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  };

  return future ? `in ${render()}` : `${render()} ago`;
}

export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value)}%`;
}

const TRIGGER_LABELS: Record<string, string> = {
  cron: 'Cron schedule',
  interval: 'Every N minutes',
  session_reset: 'New 5h session',
  weekly_reset: 'New week',
  quota_available: 'Tokens available',
  manual: 'Manual',
  follow_up: 'Follow-up',
};

export function triggerLabel(type: string): string {
  if (TRIGGER_LABELS[type]) return TRIGGER_LABELS[type]!;
  if (type.startsWith('auto_resume:')) return 'Auto-resume';
  if (type.startsWith('manual_resume:')) return 'Manual resume';
  if (type.startsWith('manual:')) return 'Manual';
  return type;
}
