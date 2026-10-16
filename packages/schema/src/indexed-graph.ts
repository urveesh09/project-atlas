import { z } from 'zod';
import { canonicalJson, utf8ByteLength } from './canonical.js';
import {
  BuiltinNodeSchema,
  DeclaredRangeSchema,
  DiagnosticSchema,
  DirectoryNodeSchema,
  ExternalPackageNodeSchema,
  FileNodeSchema,
  GraphEdgeSchema,
  GraphSnapshotSchema,
  ImportObservationSchema,
  NodeMetricsSchema,
  PackageNodeSchema,
  RepositoryNodeSchema,
  nodeIdentityKey,
  type GraphNode,
  type GraphSnapshot,
} from './graph.js';
import { edgeId, nodeId, observationId } from './ids.js';
import { LIMITS } from './limits.js';

export const INDEXED_GRAPH_ENCODING = 'atlas.graph.indexed/1' as const;
const index = z
  .number()
  .int()
  .min(0)
  .max(LIMITS.treeEntriesPerSnapshot - 1);
const observationIndex = z
  .number()
  .int()
  .min(0)
  .max(LIMITS.dependencyEvidenceRowsPerSnapshot - 1);
const omitNode = { id: true, parentId: true } as const;
const indexedNode = z.discriminatedUnion('kind', [
  RepositoryNodeSchema.omit(omitNode).extend({ parentId: index.nullable() }),
  PackageNodeSchema.omit(omitNode).extend({ parentId: index.nullable() }),
  DirectoryNodeSchema.omit(omitNode).extend({ parentId: index.nullable() }),
  FileNodeSchema.omit(omitNode).extend({ parentId: index.nullable() }),
  ExternalPackageNodeSchema.omit(omitNode).extend({
    parentId: index.nullable(),
    declaredRanges: z
      .array(DeclaredRangeSchema.omit({ packageNodeId: true }).extend({ packageNodeId: index }))
      .max(1024),
  }),
  BuiltinNodeSchema.omit(omitNode).extend({ parentId: index.nullable() }),
]);

/** A wire contract, never the canonical graph API. Its collections keep canonical order. */
export const IndexedGraphSchema = GraphSnapshotSchema.omit({
  nodes: true,
  edges: true,
  importObservations: true,
  diagnostics: true,
  metrics: true,
}).extend({
  encoding: z.literal(INDEXED_GRAPH_ENCODING),
  nodes: z.array(indexedNode).max(LIMITS.treeEntriesPerSnapshot),
  edges: z
    .array(
      GraphEdgeSchema.omit({ id: true, sourceId: true, targetId: true, evidenceIds: true }).extend({
        sourceId: index,
        targetId: index,
        evidenceIds: z.array(observationIndex).max(LIMITS.dependencyEvidenceRowsPerSnapshot),
      }),
    )
    .max(LIMITS.sourceDependencyEdgesPerSnapshot),
  importObservations: z
    .array(
      ImportObservationSchema.omit({ id: true, sourceId: true, targetId: true }).extend({
        sourceId: index,
        targetId: index.nullable(),
      }),
    )
    .max(LIMITS.dependencyEvidenceRowsPerSnapshot),
  diagnostics: z
    .array(
      DiagnosticSchema.omit({ subjectIds: true, evidenceIds: true }).extend({
        subjectIds: z.array(index).min(1).max(2000),
        evidenceIds: z.array(observationIndex).max(2000),
      }),
    )
    .max(LIMITS.diagnosticsPerFrame),
  metrics: z
    .array(NodeMetricsSchema.omit({ nodeId: true }).extend({ nodeId: index }))
    .max(LIMITS.treeEntriesPerSnapshot),
});
export type IndexedGraph = z.infer<typeof IndexedGraphSchema>;

function lookup(map: ReadonlyMap<string, number>, id: string): number {
  const value = map.get(id);
  if (value === undefined) throw new TypeError('Indexed graph contains a dangling reference');
  return value;
}
function dereference(ids: readonly string[], position: number): string {
  const id = ids[position];
  if (id === undefined) throw new TypeError('Indexed graph reference is out of bounds');
  return id;
}

/** Caller validates canonical input first: deriving IDs must never repair invalid data. */
export function encodeIndexedGraph(graph: GraphSnapshot): IndexedGraph {
  const nodeIndices = new Map(graph.nodes.map((n, i) => [n.id, i]));
  const observationIndices = new Map(graph.importObservations.map((o, i) => [o.id, i]));
  const nodes = graph.nodes.map(({ id: _id, parentId, ...node }) => {
    const base = { ...node, parentId: parentId === null ? null : lookup(nodeIndices, parentId) };
    return base.kind === 'external-package'
      ? {
          ...base,
          declaredRanges: base.declaredRanges.map((r) => ({
            ...r,
            packageNodeId: lookup(nodeIndices, r.packageNodeId),
          })),
        }
      : base;
  });
  return {
    ...graph,
    encoding: INDEXED_GRAPH_ENCODING,
    nodes,
    edges: graph.edges.map(({ id: _id, ...e }) => ({
      ...e,
      sourceId: lookup(nodeIndices, e.sourceId),
      targetId: lookup(nodeIndices, e.targetId),
      evidenceIds: e.evidenceIds.map((id) => lookup(observationIndices, id)),
    })),
    importObservations: graph.importObservations.map(({ id: _id, ...o }) => ({
      ...o,
      sourceId: lookup(nodeIndices, o.sourceId),
      targetId: o.targetId === null ? null : lookup(nodeIndices, o.targetId),
    })),
    diagnostics: graph.diagnostics.map((d) => ({
      ...d,
      subjectIds: d.subjectIds.map((id) => lookup(nodeIndices, id)),
      evidenceIds: d.evidenceIds.map((id) => lookup(observationIndices, id)),
    })),
    metrics: graph.metrics.map((m) => ({ ...m, nodeId: lookup(nodeIndices, m.nodeId) })),
  };
}

/** Shape/count validation precedes allocations and reference expansion. Final invariants remain mandatory. */
export function decodeIndexedGraph(
  input: unknown,
  maxDecodedBytes: number = LIMITS.artifactUncompressedBytes,
): GraphSnapshot {
  const { encoding: _encoding, ...wire } = IndexedGraphSchema.parse(input);
  // Bound expansion before allocating any IDs. Integer references can expand by ~70
  // bytes each, so trusting just gzip output size would allow a reference bomb.
  // Key ordering changes no bytes in the length. Strict fields are JSON-safe; arbitrary
  // extensions still receive canonical Unicode/value validation before any expansion.
  if (wire.extensions !== undefined) canonicalJson(wire.extensions);
  else if (Object.hasOwn(wire, 'extensions')) throw new TypeError('Undefined extension value');
  let expandedBytes = utf8ByteLength(JSON.stringify(wire));
  const referenceCost = (position: number, count: number, idLength: number): number => {
    if (position >= count) throw new TypeError('Indexed graph reference is out of bounds');
    return idLength + 2 - String(position).length;
  };
  const nodeCost = (position: number) => referenceCost(position, wire.nodes.length, 69);
  const obsCost = (position: number) => referenceCost(position, wire.importObservations.length, 68);
  for (const n of wire.nodes) {
    expandedBytes += 77; // comma + "id":"node_<64 hex>"
    if (n.parentId !== null) expandedBytes += nodeCost(n.parentId);
    if (n.kind === 'external-package') for (const r of n.declaredRanges) expandedBytes += nodeCost(r.packageNodeId);
  }
  for (const o of wire.importObservations)
    expandedBytes += 76 + nodeCost(o.sourceId) + (o.targetId === null ? 0 : nodeCost(o.targetId));
  for (const e of wire.edges) {
    expandedBytes += 77 + nodeCost(e.sourceId) + nodeCost(e.targetId);
    for (const i of e.evidenceIds) expandedBytes += obsCost(i);
  }
  for (const d of wire.diagnostics) {
    for (const i of d.subjectIds) expandedBytes += nodeCost(i);
    for (const i of d.evidenceIds) expandedBytes += obsCost(i);
  }
  for (const m of wire.metrics) expandedBytes += nodeCost(m.nodeId);
  if (expandedBytes > maxDecodedBytes) throw new RangeError('Indexed graph exceeds decoded size limit');
  const nodeIds = wire.nodes.map((n) => nodeId(wire.snapshotId, n.kind, nodeIdentityKey(n)));
  const nodes: GraphNode[] = wire.nodes.map((n, i) => {
    const base = { ...n, id: nodeIds[i]!, parentId: n.parentId === null ? null : dereference(nodeIds, n.parentId) };
    return base.kind === 'external-package'
      ? {
          ...base,
          declaredRanges: base.declaredRanges.map((r) => ({
            ...r,
            packageNodeId: dereference(nodeIds, r.packageNodeId),
          })),
        }
      : base;
  });
  const importObservations = wire.importObservations.map((o) => {
    const sourceId = dereference(nodeIds, o.sourceId);
    return {
      ...o,
      id: observationId(wire.snapshotId, sourceId, o.kind, o.range, o.specifier),
      sourceId,
      targetId: o.targetId === null ? null : dereference(nodeIds, o.targetId),
    };
  });
  const observationIds = importObservations.map((o) => o.id);
  return {
    ...wire,
    nodes,
    importObservations,
    edges: wire.edges.map((e) => {
      const sourceId = dereference(nodeIds, e.sourceId),
        targetId = dereference(nodeIds, e.targetId);
      return {
        ...e,
        id: edgeId(wire.snapshotId, sourceId, targetId, e.kind, e.confidence),
        sourceId,
        targetId,
        evidenceIds: e.evidenceIds.map((i) => dereference(observationIds, i)),
      };
    }),
    diagnostics: wire.diagnostics.map((d) => ({
      ...d,
      subjectIds: d.subjectIds.map((i) => dereference(nodeIds, i)),
      evidenceIds: d.evidenceIds.map((i) => dereference(observationIds, i)),
    })),
    metrics: wire.metrics.map((m) => ({ ...m, nodeId: dereference(nodeIds, m.nodeId) })),
  };
}
