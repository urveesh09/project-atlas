import { buildingHeight, computeLayout, type LayoutTreeNode } from '@atlas/layout';
import { canonicalJsonSha256, compareAscii, compareUtf8, districtId, perimeterName, type GraphNode, type GraphSnapshot, type LayoutArtifact } from '@atlas/schema';

/**
 * One plot plan over the union of analyzed frames (plan §11.3, ADR-008).
 *
 * Each lineage's layout anchor is its latest present frame (HEAD when present), whose
 * path and container chain fix its district and plot in every frame. Containers are
 * identified by path: a path that is a directory in one frame and a package in another is
 * one district, taking its kind and parent from the newest frame containing it, so the
 * district tree is acyclic (a parent path is always a proper prefix). Every container of
 * the selected commit keeps a district (navigation), as do the anchor chains of files
 * deleted before it. Frames then record per-file heights and an explicit
 * container-to-district map, nullable when a historical container anchors nothing.
 */
interface ContainerRecord {
  key: string;
  kind: 'repository' | 'package' | 'directory';
  path: string;
  parentKey: string | null;
}

type Container = Extract<GraphNode, { kind: 'repository' | 'package' | 'directory' }>;
const isContainer = (n: GraphNode): n is Container => n.kind === 'repository' || n.kind === 'package' || n.kind === 'directory';
const containerKey = (n: Container) => (n.kind === 'repository' ? 'R' : `C\u0000${n.path}`);

export function buildUnionLayout(repoId: string, graphs: readonly GraphSnapshot[]): LayoutArtifact {
  if (graphs.length === 0) throw new RangeError('A layout needs at least one frame');
  const records = new Map<string, ContainerRecord>();
  // Newest frame first: the first record for a container path wins.
  for (let f = graphs.length - 1; f >= 0; f--) {
    const nodes = new Map(graphs[f]!.nodes.map((n) => [n.id, n]));
    for (const node of graphs[f]!.nodes) {
      if (!isContainer(node)) continue;
      const key = containerKey(node);
      if (records.has(key)) continue;
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      records.set(key, {
        key,
        kind: node.kind,
        path: node.kind === 'repository' ? '' : node.path,
        parentKey: parent && isContainer(parent) ? containerKey(parent) : null,
      });
    }
  }

  // Anchors: newest frame where each lineage is present.
  const anchors = new Map<string, { path: string; containerKey: string }>();
  for (let f = graphs.length - 1; f >= 0; f--) {
    const nodes = new Map(graphs[f]!.nodes.map((n) => [n.id, n]));
    for (const node of graphs[f]!.nodes) {
      if (node.kind !== 'file' || node.lineageId === null || anchors.has(node.lineageId)) continue;
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      if (!parent || !isContainer(parent)) throw new Error('A file occurrence has no container parent');
      anchors.set(node.lineageId, { path: node.path, containerKey: containerKey(parent) });
    }
  }

  // Included containers: every container of the selected commit plus anchor chains.
  const included = new Set<string>();
  const include = (key: string | null) => {
    while (key !== null && !included.has(key)) {
      included.add(key);
      key = records.get(key)?.parentKey ?? null;
    }
  };
  for (const node of graphs.at(-1)!.nodes) if (isContainer(node)) include(containerKey(node));
  for (const anchor of anchors.values()) include(anchor.containerKey);

  const children = new Map<string, string[]>();
  const directFiles = new Map<string, string[]>();
  let rootKey: string | null = null;
  for (const key of included) {
    const record = records.get(key)!;
    if (record.parentKey === null || !included.has(record.parentKey)) {
      if (rootKey !== null) throw new Error('The district union has more than one root');
      rootKey = key;
    } else {
      const list = children.get(record.parentKey) ?? [];
      list.push(key);
      children.set(record.parentKey, list);
    }
  }
  if (rootKey === null) throw new Error('The district union has no root');
  for (const [lineage, anchor] of anchors) {
    const list = directFiles.get(anchor.containerKey) ?? [];
    list.push(lineage);
    directFiles.set(anchor.containerKey, list);
  }
  const toTree = (key: string): LayoutTreeNode => {
    const record = records.get(key)!;
    return {
      kind: record.kind,
      path: record.path,
      files: directFiles.get(key) ?? [],
      children: (children.get(key) ?? []).sort(compareUtf8).map(toTree),
    };
  };
  const districtOf = (key: string): string => {
    const record = records.get(key)!;
    return districtId(repoId, record.kind, record.path);
  };

  const externals = new Set<string>();
  for (const graph of graphs)
    for (const n of graph.nodes) {
      if (n.kind === 'external-package' || n.kind === 'builtin') externals.add(perimeterName(n));
    }
  // The layout ID covers the ordered frame set and the lineage anchors (plan §6.5).
  const frameKey = canonicalJsonSha256({
    frames: graphs.map((g) => g.snapshotId),
    anchors: [...anchors].map(([lineage, a]) => [lineage, a.path]).sort((x, y) => compareAscii(x[0]!, y[0]!)),
  });
  const geometry = computeLayout({ repoId, frameKey, externals: [...externals], root: toTree(rootKey) });

  const frameState = graphs.map((graph) => {
    const codeLines = new Map(graph.metrics.map((m) => [m.nodeId, m.codeLines]));
    const containers = graph.nodes
      .filter(isContainer)
      .map((n) => {
        const key = containerKey(n);
        return { graphNodeId: n.id, layoutDistrictId: included.has(key) ? districtOf(key) : null };
      })
      .sort((a, b) => compareAscii(a.graphNodeId, b.graphNodeId));
    const files = graph.nodes
      .flatMap((n) =>
        n.kind === 'file'
          ? [{ nodeId: n.id, lineageId: n.lineageId!, currentParentId: n.parentId!, height: buildingHeight(n.role, n.parseStatus, codeLines.get(n.id) ?? null), present: true as const }]
          : [],
      )
      .sort((a, b) => compareAscii(a.lineageId, b.lineageId));
    return { snapshotId: graph.snapshotId, containers, files };
  });
  return { ...geometry, frameState };
}
