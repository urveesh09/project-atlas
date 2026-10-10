import type { FileNode, GraphSnapshot, NodeMetrics } from '@atlas/schema';
import { midrankPercentiles } from './stats.js';

/**
 * Hotspot score and Structure attention (plan §10.3, ADR-009). Both are repository-relative
 * heuristics for "candidate for inspection", never quality grades. One fixed baseline from
 * the latest complete HEAD metrics grades every frame of an artifact, so moving along the
 * history never regrades the city.
 */
export const HOTSPOT_WEIGHTS = Object.freeze({ complexity: 0.4, fanIn: 0.25, changedCommits: 0.35 });
export const STRUCTURE_ATTENTION_WEIGHTS = Object.freeze({ complexity: 0.6, fanIn: 0.4 });

/** Distinct sorted cohort values and the midrank percentile each holds in the cohort. */
export interface PercentileBaseline {
  values: number[];
  percentiles: number[];
  cohortSize: number;
  /** Every cohort value is identical: the factor cannot discriminate (exposed in the UI). */
  allIdentical: boolean;
}

export function percentileBaseline(cohort: readonly number[]): PercentileBaseline | null {
  if (cohort.length === 0) return null;
  const ranks = midrankPercentiles(cohort);
  const byValue = new Map<number, number>();
  cohort.forEach((value, i) => byValue.set(value, ranks[i]!));
  const values = [...byValue.keys()].sort((a, b) => a - b);
  return { values, percentiles: values.map((v) => byValue.get(v)!), cohortSize: cohort.length, allIdentical: values.length === 1 };
}

/**
 * Percentile of `value` against a baseline: exact for baseline values, linear between two
 * distinct neighbours' midrank percentiles, clamped to the endpoint percentiles outside.
 */
export function baselinePercentile(baseline: PercentileBaseline, value: number): number {
  const { values, percentiles } = baseline;
  if (value <= values[0]!) return percentiles[0]!;
  if (value >= values.at(-1)!) return percentiles.at(-1)!;
  let lo = 0;
  let hi = values.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (values[mid]! <= value) lo = mid;
    else hi = mid;
  }
  if (values[lo] === value) return percentiles[lo]!;
  const t = (value - values[lo]!) / (values[hi]! - values[lo]!);
  return percentiles[lo]! + t * (percentiles[hi]! - percentiles[lo]!);
}

export interface HotspotBaseline {
  /** Snapshot whose metrics define the baseline (the selected commit). */
  snapshotId: string;
  cohortSize: number;
  complexity: PercentileBaseline | null;
  fanIn: PercentileBaseline | null;
  /** Null when the HEAD frame has no usable history: the full score is then unavailable. */
  changedCommits: PercentileBaseline | null;
}

/**
 * Eligible: an included, parsed production-source file whose complexity and dependency
 * metrics are complete. Tests, configuration, declarations and generated/opaque files form
 * separate cohorts and are never ranked here.
 */
export function isHotspotEligible(node: FileNode, metric: NodeMetrics | undefined): metric is NodeMetrics & { maxCyclomatic: number; fanIn: number } {
  return (
    node.role === 'source' &&
    node.parseStatus === 'parsed' &&
    metric !== undefined &&
    metric.maxCyclomatic !== null &&
    metric.fanIn !== null &&
    metric.availability.dependencies === 'complete'
  );
}

export function hasUsableHistory(metric: NodeMetrics): metric is NodeMetrics & { changedCommits: number } {
  return metric.changedCommits !== null && metric.availability.history !== 'unavailable';
}

export function hotspotBaseline(head: GraphSnapshot): HotspotBaseline {
  const metrics = new Map(head.metrics.map((m) => [m.nodeId, m]));
  const cohort: (NodeMetrics & { maxCyclomatic: number; fanIn: number })[] = [];
  for (const node of head.nodes) {
    if (node.kind !== 'file') continue;
    const metric = metrics.get(node.id);
    if (isHotspotEligible(node, metric)) cohort.push(metric);
  }
  const withHistory = cohort.filter((m): m is typeof m & { changedCommits: number } => hasUsableHistory(m));
  return {
    snapshotId: head.snapshotId,
    cohortSize: cohort.length,
    complexity: percentileBaseline(cohort.map((m) => m.maxCyclomatic)),
    fanIn: percentileBaseline(cohort.map((m) => m.fanIn)),
    // History is comparable only if every cohort member has it.
    changedCommits: cohort.length > 0 && withHistory.length === cohort.length ? percentileBaseline(withHistory.map((m) => m.changedCommits)) : null,
  };
}

export interface HotspotFactors {
  pComplexity: number;
  pFanIn: number;
  pChangedCommits: number | null;
  /** Full hotspot score, or null when usable history is absent. */
  score: number | null;
  /** The separately labelled structure-only score; never presented as the hotspot score. */
  structureAttention: number;
}

/** Factors for one eligible file; null when the file is outside the scored cohort. */
export function hotspotFactors(baseline: HotspotBaseline, node: FileNode, metric: NodeMetrics | undefined): HotspotFactors | null {
  if (!isHotspotEligible(node, metric) || !baseline.complexity || !baseline.fanIn) return null;
  const pComplexity = baselinePercentile(baseline.complexity, metric.maxCyclomatic);
  const pFanIn = baselinePercentile(baseline.fanIn, metric.fanIn);
  const pChangedCommits = baseline.changedCommits && hasUsableHistory(metric) ? baselinePercentile(baseline.changedCommits, metric.changedCommits) : null;
  const W = HOTSPOT_WEIGHTS;
  const S = STRUCTURE_ATTENTION_WEIGHTS;
  return {
    pComplexity,
    pFanIn,
    pChangedCommits,
    score: pChangedCommits === null ? null : Math.round(100 * (W.complexity * pComplexity + W.fanIn * pFanIn + W.changedCommits * pChangedCommits)),
    structureAttention: Math.round(100 * (S.complexity * pComplexity + S.fanIn * pFanIn)),
  };
}
