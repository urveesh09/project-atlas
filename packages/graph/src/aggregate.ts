import { LIMITS, compareAscii, edgeId, type Confidence, type EdgeKind, type GraphEdge, type ImportObservation } from '@atlas/schema';

/**
 * Edge aggregation (plan §6.3): observations with identical (source, target, kind,
 * confidence) become one edge whose count is exact. When a snapshot exceeds its evidence
 * or edge budget, truncation is deterministic (by ID) and every omission is counted.
 */
export interface AggregationLimits {
  edges: number;
  evidenceRows: number;
}

export interface AggregationResult {
  edges: GraphEdge[];
  /** Observations retained as evidence (sorted by ID). */
  observations: ImportObservation[];
  observationsOmitted: number;
  edgesOmitted: number;
  /** Observations whose aggregate edge was dropped by the edge cap. */
  edgeObservationsOmitted: number;
}

export function aggregateEdges(
  snapshotId: string,
  observations: readonly ImportObservation[],
  limits: AggregationLimits = { edges: LIMITS.sourceDependencyEdgesPerSnapshot, evidenceRows: LIMITS.dependencyEvidenceRowsPerSnapshot },
): AggregationResult {
  const sorted = [...observations].sort((a, b) => compareAscii(a.id, b.id));
  const retained = sorted.slice(0, limits.evidenceRows);
  const retainedIds = new Set(retained.map((o) => o.id));

  const groups = new Map<string, { sourceId: string; targetId: string; kind: EdgeKind; confidence: Confidence; count: number; evidence: string[] }>();
  for (const obs of sorted) {
    if (obs.targetId === null || obs.confidence === null) continue;
    const id = edgeId(snapshotId, obs.sourceId, obs.targetId, obs.kind, obs.confidence);
    let group = groups.get(id);
    if (!group) {
      group = { sourceId: obs.sourceId, targetId: obs.targetId, kind: obs.kind, confidence: obs.confidence, count: 0, evidence: [] };
      groups.set(id, group);
    }
    group.count++;
    if (retainedIds.has(obs.id)) group.evidence.push(obs.id);
  }
  const all: GraphEdge[] = [...groups].map(([id, g]) => ({
    id,
    sourceId: g.sourceId,
    targetId: g.targetId,
    kind: g.kind,
    confidence: g.confidence,
    observationCount: g.count,
    evidenceIds: g.evidence,
    evidenceOmitted: g.count - g.evidence.length,
  }));
  all.sort((a, b) => compareAscii(a.id, b.id));
  const edges = all.slice(0, limits.edges);
  const dropped = all.slice(limits.edges);
  return {
    edges,
    observations: retained,
    observationsOmitted: sorted.length - retained.length,
    edgesOmitted: dropped.length,
    edgeObservationsOmitted: dropped.reduce((sum, e) => sum + e.observationCount, 0),
  };
}
