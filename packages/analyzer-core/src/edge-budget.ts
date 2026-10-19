import type { AggregationResult } from '@atlas/graph';
import { LIMITS, compareAscii, type GraphEdge } from '@atlas/schema';

/** All dependency relationships share the existing canonical/wire edge ceiling. */
export function boundSnapshotEdges(
  packageEdges: readonly GraphEdge[],
  source: Pick<AggregationResult, 'edges' | 'edgesOmitted' | 'edgeObservationsOmitted'>,
): { edges: GraphEdge[]; edgesOmitted: number; relationshipsOmitted: number } {
  const all = [...packageEdges, ...source.edges].sort((a, b) => compareAscii(a.id, b.id));
  const omitted = all.slice(LIMITS.sourceDependencyEdgesPerSnapshot);
  return {
    // The source aggregator already retained its lowest IDs. None of its discarded
    // IDs can enter the joint prefix when package relationships are added.
    edges: omitted.length === 0 ? all : all.slice(0, LIMITS.sourceDependencyEdgesPerSnapshot),
    edgesOmitted: source.edgesOmitted + omitted.length,
    relationshipsOmitted: source.edgeObservationsOmitted + omitted.reduce((total, edge) => total + edge.observationCount, 0),
  };
}
