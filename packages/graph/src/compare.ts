import { compareAscii, compareUtf8, type EdgeKind, type FileNode, type FileRole, type GraphNode, type GraphSnapshot, type NodeMetrics } from '@atlas/schema';

/**
 * Two-frame comparison inside one artifact (plan §7.4). Frames are compared A -> B in the
 * order given, even when B is older. File occurrences match by lineage ID (both frames
 * share the artifact's lineage policy, so no path guessing is needed); dependency edges
 * are projected onto lineages and perimeter names because occurrence IDs differ by frame.
 * Presence changes never imply parsed changes, and a null metric delta stays null.
 */
export const COMPARED_METRICS = ['codeLines', 'physicalLines', 'maxCyclomatic', 'sumCyclomatic', 'fanIn', 'fanOut', 'changedCommits', 'linesAdded', 'linesDeleted', 'hotspotScore'] as const;
export type ComparedMetric = (typeof COMPARED_METRICS)[number];

export interface ComparedFile {
  lineageId: string;
  path: string;
  role: FileRole;
}

export interface MetricDelta {
  metric: ComparedMetric;
  from: number | null;
  to: number | null;
  /** to - from when both are known; otherwise null with the side that is unavailable. */
  delta: number | null;
  unavailable: 'from' | 'to' | 'both' | null;
}

export interface ComparedEdge {
  sourceLineageId: string;
  sourcePath: string;
  /** A lineage ID for files, or a canonical perimeter name (`npm:react`, `builtin:fs`). */
  target: string;
  targetLabel: string;
  kind: EdgeKind;
}

export interface FrameComparison {
  fromSnapshotId: string;
  toSnapshotId: string;
  added: ComparedFile[];
  deleted: ComparedFile[];
  renamed: { lineageId: string; fromPath: string; toPath: string }[];
  /** Same lineage whose containing package/directory changed (includes renames across folders). */
  moved: { lineageId: string; path: string; fromParent: string; toParent: string }[];
  modified: { lineageId: string; path: string; fromBlobOid: string; toBlobOid: string }[];
  roleChanged: { lineageId: string; path: string; from: FileRole; to: FileRole }[];
  metricChanges: { lineageId: string; path: string; deltas: MetricDelta[] }[];
  edgesAdded: ComparedEdge[];
  edgesRemoved: ComparedEdge[];
  /** Files present in both frames with identical blob, path and role. */
  unchangedFiles: number;
}

/** Package/project edges describe manifests, not file imports; they are not compared here. */
const FILE_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(['imports-value', 'imports-type', 'reexports-value', 'reexports-type', 'imports-dynamic-literal', 'requires-literal', 'imports-resource']);

function containerPath(nodes: ReadonlyMap<string, GraphNode>, node: FileNode): string {
  const parent = node.parentId ? nodes.get(node.parentId) : undefined;
  if (!parent) return '';
  if (parent.kind === 'repository') return '/';
  return 'path' in parent ? `${parent.kind}:${parent.path}` : parent.kind;
}

function perimeterName(node: GraphNode): string | null {
  if (node.kind === 'external-package') return `npm:${node.packageName}`;
  if (node.kind === 'builtin') return `builtin:${node.moduleName}`;
  return null;
}

function projectEdges(graph: GraphSnapshot): Map<string, ComparedEdge> {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const out = new Map<string, ComparedEdge>();
  for (const edge of graph.edges) {
    if (!FILE_EDGE_KINDS.has(edge.kind)) continue;
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (source?.kind !== 'file' || !source.lineageId || !target) continue;
    const projected = target.kind === 'file' ? target.lineageId : perimeterName(target);
    if (!projected) continue;
    const label = target.kind === 'file' ? target.path : projected;
    // Confidence is evidence quality, not identity: an edge whose confidence changes is
    // the same dependency. Kind is part of identity (a value import is not a type import).
    out.set(`${source.lineageId}\u0000${projected}\u0000${edge.kind}`, { sourceLineageId: source.lineageId, sourcePath: source.path, target: projected, targetLabel: label, kind: edge.kind });
  }
  return out;
}

function files(graph: GraphSnapshot): Map<string, FileNode> {
  const out = new Map<string, FileNode>();
  for (const node of graph.nodes) if (node.kind === 'file' && node.lineageId) out.set(node.lineageId, node);
  return out;
}

const byPath = <T extends { path: string; lineageId: string }>(a: T, b: T) => compareUtf8(a.path, b.path) || compareAscii(a.lineageId, b.lineageId);
const edgeOrder = (a: ComparedEdge, b: ComparedEdge) => compareUtf8(a.sourcePath, b.sourcePath) || compareUtf8(a.targetLabel, b.targetLabel) || compareAscii(a.kind, b.kind);

export function compareFrames(from: GraphSnapshot, to: GraphSnapshot): FrameComparison {
  const a = files(from);
  const b = files(to);
  const aNodes = new Map(from.nodes.map((n) => [n.id, n]));
  const bNodes = new Map(to.nodes.map((n) => [n.id, n]));
  const aMetrics = new Map(from.metrics.map((m) => [m.nodeId, m]));
  const bMetrics = new Map(to.metrics.map((m) => [m.nodeId, m]));
  const result: FrameComparison = {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    added: [],
    deleted: [],
    renamed: [],
    moved: [],
    modified: [],
    roleChanged: [],
    metricChanges: [],
    edgesAdded: [],
    edgesRemoved: [],
    unchangedFiles: 0,
  };
  for (const [lineage, node] of a) if (!b.has(lineage)) result.deleted.push({ lineageId: lineage, path: node.path, role: node.role });
  for (const [lineage, node] of b) {
    const before = a.get(lineage);
    if (!before) {
      result.added.push({ lineageId: lineage, path: node.path, role: node.role });
      continue;
    }
    let same = true;
    if (before.path !== node.path) {
      result.renamed.push({ lineageId: lineage, fromPath: before.path, toPath: node.path });
      same = false;
    }
    const fromParent = containerPath(aNodes, before);
    const toParent = containerPath(bNodes, node);
    if (fromParent !== toParent) result.moved.push({ lineageId: lineage, path: node.path, fromParent, toParent });
    if (before.blobOid !== node.blobOid) {
      result.modified.push({ lineageId: lineage, path: node.path, fromBlobOid: before.blobOid, toBlobOid: node.blobOid });
      same = false;
    }
    if (before.role !== node.role) {
      result.roleChanged.push({ lineageId: lineage, path: node.path, from: before.role, to: node.role });
      same = false;
    }
    if (same) result.unchangedFiles++;
    const deltas = metricDeltas(aMetrics.get(before.id), bMetrics.get(node.id));
    if (deltas.length > 0) result.metricChanges.push({ lineageId: lineage, path: node.path, deltas });
  }
  const aEdges = projectEdges(from);
  const bEdges = projectEdges(to);
  for (const [key, edge] of bEdges) if (!aEdges.has(key)) result.edgesAdded.push(edge);
  for (const [key, edge] of aEdges) if (!bEdges.has(key)) result.edgesRemoved.push(edge);

  result.added.sort(byPath);
  result.deleted.sort(byPath);
  result.renamed.sort((x, y) => compareUtf8(x.toPath, y.toPath) || compareAscii(x.lineageId, y.lineageId));
  result.moved.sort(byPath);
  result.modified.sort(byPath);
  result.roleChanged.sort(byPath);
  result.metricChanges.sort(byPath);
  result.edgesAdded.sort(edgeOrder);
  result.edgesRemoved.sort(edgeOrder);
  return result;
}

/** Changed or availability-changed metrics; unchanged known values are omitted. */
export function metricDeltas(from: NodeMetrics | undefined, to: NodeMetrics | undefined): MetricDelta[] {
  const out: MetricDelta[] = [];
  for (const metric of COMPARED_METRICS) {
    const x = from ? from[metric] : null;
    const y = to ? to[metric] : null;
    if (x === y) continue;
    out.push({
      metric,
      from: x,
      to: y,
      delta: x !== null && y !== null ? y - x : null,
      unavailable: x === null && y === null ? 'both' : x === null ? 'from' : y === null ? 'to' : null,
    });
  }
  return out;
}
