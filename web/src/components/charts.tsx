import { formatTokens } from '../format';

export interface Segment {
  label: string;
  value: number;
  color: string;
}

/**
 * Part-to-whole for a small fixed set of series. The legend carries the label
 * and the value for every segment, which is also the relief for the light-mode
 * contrast warning on the lighter hues — identity is never colour alone.
 */
export function StackedBar({ segments, unit = 'tokens' }: { segments: Segment[]; unit?: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  if (total <= 0) {
    return <div className="empty">No {unit} recorded yet.</div>;
  }
  return (
    <div>
      <div className="stacked" role="img" aria-label={`${formatTokens(total)} ${unit} by kind`}>
        {segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <div
              key={segment.label}
              className="stacked-seg"
              style={{ width: `${(segment.value / total) * 100}%`, background: segment.color }}
            />
          ))}
      </div>
      <div className="series-legend">
        {segments.map((segment) => (
          <div className="series-legend-item" key={segment.label}>
            <span className="swatch" style={{ background: segment.color }} aria-hidden />
            <span className="series-legend-label">{segment.label}</span>
            <span className="series-legend-value">{formatTokens(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface ColumnPoint {
  label: string;
  value: number;
  title: string;
}

/**
 * One series over time. Single series, so magnitude reads from a single
 * sequential hue and no legend box is needed — the card title says what it is.
 */
export function ColumnChart({ points, tickEvery = 2 }: { points: ColumnPoint[]; tickEvery?: number }) {
  if (points.length === 0) return <div className="empty">Nothing to plot yet.</div>;

  const max = Math.max(...points.map((point) => point.value), 1);
  const peak = points.reduce((best, point) => (point.value > best.value ? point : best), points[0]!);

  return (
    <div>
      <div className="columns">
        {points.map((point) => (
          <div className="column-slot" key={point.label} title={point.title}>
            {point === peak && point.value > 0 && (
              <span
                className="stat-note"
                style={{ position: 'absolute', top: -18, whiteSpace: 'nowrap' }}
              >
                {formatTokens(point.value)}
              </span>
            )}
            <div
              className={`column-bar${point.value === 0 ? ' is-zero' : ''}`}
              style={{ height: `${point.value === 0 ? 2 : Math.max(4, (point.value / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="column-axis">
        {points.map((point, index) => (
          <span key={point.label}>{index % tickEvery === 0 ? point.label : ''}</span>
        ))}
      </div>
    </div>
  );
}

export interface BarRow {
  label: string;
  value: number;
  display: string;
  href?: string;
}

/** Ranked magnitude with long labels — horizontal bars, one sequential hue. */
export function BarList({ rows }: { rows: BarRow[] }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <div>
      {rows.map((row) => (
        <div className="bar-row" key={row.label}>
          <span className="bar-label" title={row.label}>
            {row.label}
          </span>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }} />
          </div>
          <span className="bar-value">{row.display}</span>
        </div>
      ))}
    </div>
  );
}
