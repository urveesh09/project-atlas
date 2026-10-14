import { useEffect, useState } from 'react';
import { METRIC_PALETTE, UNKNOWN_COLOR } from '@atlas/layout';
import { evenStops, invalidStops, type Distribution } from '../app/bands';
import { MenuSummary } from './MenuSummary';

const fmt = (n: number | null) => (n === null ? '—' : n.toLocaleString('en-US'));

/**
 * The Bands menu (ADR-052): the distribution of the lens metric over the files shown, as a
 * bar per colour band, and the band starts, editable or split evenly.
 */
export function BandsMenu(props: {
  label: string;
  stops: readonly number[];
  defaults: readonly number[];
  custom: boolean;
  values: readonly number[];
  dist: Distribution;
  setStops(stops: number[] | null): void;
}) {
  const { label, stops, defaults, custom, values, dist, setStops } = props;
  const [draft, setDraft] = useState(() => stops.slice(1).map(String));
  useEffect(() => setDraft(stops.slice(1).map(String)), [stops]);
  const parsed = [0, ...draft.map((d) => (d.trim() === '' ? NaN : Number(d)))];
  const problem = invalidStops(parsed);
  const peak = Math.max(1, ...dist.counts, dist.unknown);
  const bars = [...dist.counts.map((count, i) => ({ count, color: METRIC_PALETTE[i]!, label: i === 4 ? `${stops[4]}+` : stops[i + 1]! - 1 === stops[i] ? `${stops[i]}` : `${stops[i]}–${stops[i + 1]! - 1}` })), { count: dist.unknown, color: UNKNOWN_COLOR, label: '×' }];
  const width = 260,
    height = 92,
    gap = 6,
    bar = (width - gap * (bars.length - 1)) / bars.length;
  return (
    <details className="city-views city-bands">
      <MenuSummary icon="bands" label={`Bands${custom ? ' (custom)' : ''}`} badge={custom ? '•' : null} />
      <div className="city-views-panel">
        <strong>{label}</strong>
        <svg className="bands-chart" viewBox={`0 0 ${width} ${height + 30}`} role="img" aria-label={`Distribution over the files shown: ${bars.map((b) => `${b.label === '×' ? 'unknown' : b.label}: ${b.count}`).join(', ')}`}>
          {bars.map((b, i) => {
            const h = b.count ? Math.max(2, (b.count / peak) * height) : 0;
            const x = i * (bar + gap);
            return (
              <g key={i}>
                <rect x={x} y={height - h} width={bar} height={h} rx={3} fill={b.color} stroke="rgb(0 0 0 / 0.25)" />
                <text x={x + bar / 2} y={height + 12} textAnchor="middle" className="bands-axis">
                  {b.label}
                </text>
                <text x={x + bar / 2} y={height + 25} textAnchor="middle" className="bands-count">
                  {b.count.toLocaleString('en-US')}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="city-views-empty">
          {dist.known.toLocaleString('en-US')} files with a value · median {fmt(dist.median)} · 90th percentile {fmt(dist.p90)} · max {fmt(dist.max)}
          {dist.unknown ? ` · ${dist.unknown.toLocaleString('en-US')} unknown` : ''}
        </p>
        <fieldset className="bands-stops">
          <legend>Band starts</legend>
          <span className="bands-first">
            <i style={{ background: METRIC_PALETTE[0] }} aria-hidden="true" />0
          </span>
          {draft.map((value, i) => (
            <label key={i}>
              <i style={{ background: METRIC_PALETTE[i + 1] }} aria-hidden="true" />
              <span className="sr-only">Band {i + 2} starts at</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={value}
                aria-invalid={problem ? true : undefined}
                aria-describedby="bands-problem"
                onChange={(e) => {
                  const next = draft.slice();
                  next[i] = e.target.value;
                  setDraft(next);
                  const candidate = [0, ...next.map((d) => (d.trim() === '' ? NaN : Number(d)))];
                  if (!invalidStops(candidate)) setStops(candidate.join(',') === defaults.join(',') ? null : candidate);
                }}
              />
            </label>
          ))}
        </fieldset>
        <p id="bands-problem" className={`city-views-note${problem ? ' city-note-error' : ''}`} role="status">
          {problem ? `${problem}; the last valid bands stay in use.` : 'Values are never rescaled: a file takes the band of the last start it reaches.'}
        </p>
        <div className="city-views-files">
          <button
            type="button"
            disabled={values.length === 0}
            onClick={() => {
              const even = evenStops(values);
              if (!invalidStops(even)) setStops(even);
            }}
          >
            Even split
          </button>
          <button type="button" disabled={!custom} onClick={() => setStops(null)}>
            Reset
          </button>
        </div>
      </div>
    </details>
  );
}
