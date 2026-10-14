import { UNKNOWN_COLOR, type CityBuilding } from '@atlas/layout';
import type { ComparedMetric, FrameComparison, MetricDelta } from '@atlas/graph';
import type { CityPaint } from './types';

/**
 * Change colouring for an A -> B comparison (ADR-050): each building of B is coloured by
 * the signed change of one metric since A. The numbers come from the comparison the worker
 * already computes (`metricChanges`); nothing is estimated. A metric that is unknown on
 * either side stays unknown, never "unchanged", and a file absent from A is "new".
 */
export const CHANGE_METRICS = ['codeLines', 'maxCyclomatic', 'sumCyclomatic', 'fanIn', 'fanOut', 'hotspotScore'] as const satisfies readonly ComparedMetric[];
export type ChangeMetric = (typeof CHANGE_METRICS)[number];
export const CHANGE_LABEL: Record<ChangeMetric, string> = {
  codeLines: 'Code lines',
  maxCyclomatic: 'Max complexity',
  sumCyclomatic: 'Total complexity',
  fanIn: 'Fan-in',
  fanOut: 'Fan-out',
  hotspotScore: 'Hotspot score',
};
/** A change of at least this size, either way, takes the strong band. */
export const CHANGE_STRONG: Record<ChangeMetric, number> = {
  codeLines: 50,
  maxCyclomatic: 5,
  sumCyclomatic: 10,
  fanIn: 5,
  fanOut: 5,
  hotspotScore: 10,
};
export const CHANGE_BANDS = ['much-less', 'less', 'same', 'more', 'much-more', 'new', 'unknown'] as const;
export type ChangeBand = (typeof CHANGE_BANDS)[number];
/** Diverging blue to orange (readable with red–green colour blindness); purple for new files. */
export const CHANGE_COLORS: Record<ChangeBand, string> = {
  'much-less': '#2f6b9a',
  less: '#93bcd8',
  same: '#e4dfd2',
  more: '#efb47d',
  'much-more': '#c45f2a',
  new: '#8d6bb5',
  unknown: UNKNOWN_COLOR,
};

export function changeBandLabel(band: ChangeBand, metric: ChangeMetric): string {
  const strong = CHANGE_STRONG[metric];
  switch (band) {
    case 'much-less':
      return `−${strong} or less`;
    case 'less':
      return strong > 2 ? `−${strong - 1} to −1` : '−1';
    case 'same':
      return 'unchanged';
    case 'more':
      return strong > 2 ? `+1 to +${strong - 1}` : '+1';
    case 'much-more':
      return `+${strong} or more`;
    case 'new':
      return 'new file';
    case 'unknown':
      return 'unknown';
  }
}

export interface FileChange {
  band: ChangeBand;
  from: number | null;
  to: number | null;
  /** to - from when both sides are known. */
  delta: number | null;
}

export interface ChangePaint extends CityPaint {
  metric: ChangeMetric;
  of(building: CityBuilding): FileChange;
  counts: Record<ChangeBand, number>;
}

export function bandOf(delta: number, metric: ChangeMetric): ChangeBand {
  const strong = CHANGE_STRONG[metric];
  if (delta === 0) return 'same';
  if (delta <= -strong) return 'much-less';
  if (delta < 0) return 'less';
  if (delta >= strong) return 'much-more';
  return 'more';
}

export function changePaint(comparison: FrameComparison, buildings: readonly CityBuilding[], metric: ChangeMetric): ChangePaint {
  const added = new Set(comparison.added.map((f) => f.lineageId));
  const deltas = new Map<string, MetricDelta>();
  for (const change of comparison.metricChanges) {
    const d = change.deltas.find((x) => x.metric === metric);
    if (d) deltas.set(change.lineageId, d);
  }
  const counts = Object.fromEntries(CHANGE_BANDS.map((b) => [b, 0])) as Record<ChangeBand, number>;
  const changes = new Map<string, FileChange>();
  for (const b of buildings) {
    const to = b.metric ? b.metric[metric] : null;
    let change: FileChange;
    if (added.has(b.lineageId)) change = { band: 'new', from: null, to, delta: null };
    else {
      const d = deltas.get(b.lineageId);
      if (d) change = d.delta === null ? { band: 'unknown', from: d.from, to: d.to, delta: null } : { band: bandOf(d.delta, metric), from: d.from, to: d.to, delta: d.delta };
      // No recorded difference: equal on both sides when B's value is known.
      else change = to === null ? { band: 'unknown', from: null, to: null, delta: null } : { band: 'same', from: to, to, delta: 0 };
    }
    counts[change.band]++;
    changes.set(b.lineageId, change);
  }
  const none: FileChange = { band: 'unknown', from: null, to: null, delta: null };
  const of = (b: CityBuilding) => changes.get(b.lineageId) ?? none;
  return {
    key: `${comparison.fromSnapshotId}>${comparison.toSnapshotId}:${metric}`,
    metric,
    counts,
    of,
    color: (b) => CHANGE_COLORS[of(b).band],
    unknown: (b) => of(b).band === 'unknown',
  };
}

/** Signed, grouped text for a change: "+12 (40 → 52)". */
export function formatChange(change: FileChange): string {
  const n = (v: number | null) => (v === null ? 'unknown' : v.toLocaleString('en-US', { maximumFractionDigits: 1 }));
  if (change.band === 'new') return `new (${n(change.to)})`;
  if (change.delta === null) return `unknown (${n(change.from)} → ${n(change.to)})`;
  const sign = change.delta > 0 ? '+' : change.delta < 0 ? '−' : '±';
  return `${sign}${n(Math.abs(change.delta))} (${n(change.from)} → ${n(change.to)})`;
}
