import type { PackageRollup } from '@atlas/graph';

/**
 * Package dependency view (ADR-054): packages as nodes, file imports rolled up to package
 * pairs (`GraphIndex.packageRollups`) as edges, drawn in layers.
 *
 * - Packages in a dependency cycle form one strongly connected component (Tarjan).
 * - Components are layered by the longest path to a package with no dependencies, which
 *   sits in the bottom layer; every edge between components then points down.
 * - Edges inside a component cannot point down: they are the edges that close a cycle,
 *   and are flagged.
 * - Within a layer, order follows barycentre sweeps with a name tie-break, so the result
 *   is deterministic. A layer wider than six packages wraps onto further rows, so a large
 *   cycle stays readable; every row of a layer sits above every row of the layer below.
 */
export interface PackageInput {
  id: string;
  label: string;
  path: string;
  files: number;
}
export interface PackageGraphNode extends PackageInput {
  layer: number;
  order: number;
  component: number;
  cyclic: boolean;
  /** File pairs that import within the package. */
  internalPairs: number;
  x: number;
  y: number;
  width: number;
}
export interface PackageGraphEdge {
  source: string;
  target: string;
  pairs: number;
  observations: number;
  kinds: string[];
  /** Both ends are in the same cycle: this edge closes a cycle. */
  cyclic: boolean;
}
export interface PackageGraph {
  nodes: PackageGraphNode[];
  edges: PackageGraphEdge[];
  /** Each cycle's packages, by label. */
  cycles: string[][];
  layers: number;
  width: number;
  height: number;
}

export const PACKAGE_GRAPH = { nodeHeight: 36, layerGap: 96, rowGap: 52, nodeGap: 28, margin: 24, maxNodes: 400, perRow: 6 } as const;
const byLabel = (a: { label: string; id: string }, b: { label: string; id: string }) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Iterative Tarjan: component index per node, components numbered in completion order. */
function components(ids: readonly string[], out: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const index = new Map<string, number>(),
    low = new Map<string, number>(),
    onStack = new Set<string>(),
    stack: string[] = [],
    comp = new Map<string, number>();
  let counter = 0,
    next = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    const work: { id: string; i: number }[] = [{ id: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter++);
    stack.push(root);
    onStack.add(root);
    while (work.length) {
      const frame = work.at(-1)!;
      const targets = out.get(frame.id) ?? [];
      if (frame.i < targets.length) {
        const t = targets[frame.i++]!;
        if (!index.has(t)) {
          index.set(t, counter);
          low.set(t, counter++);
          stack.push(t);
          onStack.add(t);
          work.push({ id: t, i: 0 });
        } else if (onStack.has(t)) low.set(frame.id, Math.min(low.get(frame.id)!, index.get(t)!));
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === index.get(frame.id)) {
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          comp.set(member, next);
        } while (member !== frame.id);
        next++;
      }
    }
  }
  return comp;
}

export function buildPackageGraph(packages: readonly PackageInput[], rollups: readonly PackageRollup[], measure: (label: string) => number = (l) => l.length * 7): PackageGraph {
  const inputs = [...packages].sort(byLabel);
  const known = new Set(inputs.map((p) => p.id));
  const internal = new Map<string, number>();
  const edges: PackageGraphEdge[] = [];
  for (const r of rollups) {
    if (!known.has(r.sourcePackageId) || !known.has(r.targetPackageId)) continue;
    if (r.sourcePackageId === r.targetPackageId) internal.set(r.sourcePackageId, (internal.get(r.sourcePackageId) ?? 0) + r.uniqueFilePairs);
    else edges.push({ source: r.sourcePackageId, target: r.targetPackageId, pairs: r.uniqueFilePairs, observations: r.observations, kinds: [...r.kinds], cyclic: false });
  }
  const out = new Map<string, string[]>();
  for (const e of edges) (out.get(e.source) ?? out.set(e.source, []).get(e.source)!).push(e.target);
  for (const list of out.values()) list.sort();
  const comp = components(
    inputs.map((p) => p.id),
    out,
  );
  const size = new Map<number, number>();
  for (const c of comp.values()) size.set(c, (size.get(c) ?? 0) + 1);
  for (const e of edges) e.cyclic = comp.get(e.source) === comp.get(e.target);
  // Tarjan completes components in reverse topological order, so dependencies come first:
  // a component's layer is one above the highest component it depends on.
  const compLayer = new Map<number, number>();
  const compOut = new Map<number, Set<number>>();
  for (const e of edges) {
    if (e.cyclic) continue;
    const s = comp.get(e.source)!,
      t = comp.get(e.target)!;
    (compOut.get(s) ?? compOut.set(s, new Set()).get(s)!).add(t);
  }
  const order = [...new Set(comp.values())].sort((a, b) => a - b);
  for (const c of order) {
    let layer = 0;
    for (const t of compOut.get(c) ?? []) layer = Math.max(layer, compLayer.get(t)! + 1);
    compLayer.set(c, layer);
  }
  const layers = order.length ? Math.max(...compLayer.values()) + 1 : 0;
  const nodes: PackageGraphNode[] = inputs.map((p) => ({
    ...p,
    layer: compLayer.get(comp.get(p.id)!)!,
    order: 0,
    component: comp.get(p.id)!,
    cyclic: size.get(comp.get(p.id)!)! > 1,
    internalPairs: internal.get(p.id) ?? 0,
    x: 0,
    y: 0,
    width: Math.min(220, Math.max(88, Math.ceil(measure(p.label)) + 28)),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const rows: PackageGraphNode[][] = Array.from({ length: layers }, () => []);
  for (const n of nodes) rows[n.layer]!.push(n);
  rows.forEach((row) => row.sort((a, b) => a.component - b.component || byLabel(a, b)).forEach((n, i) => (n.order = i)));
  // Barycentre sweeps: top-down by dependents above, then bottom-up by dependencies below.
  const neighbours = (n: PackageGraphNode, above: boolean) =>
    edges.filter((e) => (above ? e.target === n.id && byId.get(e.source)!.layer > n.layer : e.source === n.id && byId.get(e.target)!.layer < n.layer)).map((e) => byId.get(above ? e.source : e.target)!);
  for (let sweep = 0; sweep < 4; sweep++) {
    const above = sweep % 2 === 0;
    const sequence = above ? [...rows.keys()].reverse() : [...rows.keys()];
    for (const l of sequence) {
      const row = rows[l]!;
      const key = new Map(
        row.map((n) => {
          const ns = neighbours(n, above);
          return [n.id, ns.length ? ns.reduce((s, m) => s + m.order, 0) / ns.length : n.order];
        }),
      );
      row.sort((a, b) => key.get(a.id)! - key.get(b.id)! || byLabel(a, b)).forEach((n, i) => (n.order = i));
    }
  }
  const { nodeHeight, layerGap, rowGap, nodeGap, margin, perRow } = PACKAGE_GRAPH;
  // Top layer first; each layer wraps into rows of at most `perRow` packages.
  const lines: PackageGraphNode[][] = [];
  const firstOfLayer = new Set<number>();
  for (let l = layers - 1; l >= 0; l--) {
    const row = rows[l]!;
    firstOfLayer.add(lines.length);
    for (let i = 0; i < Math.max(1, row.length); i += perRow) lines.push(row.slice(i, i + perRow));
  }
  const widths = lines.map((line) => line.reduce((s, n) => s + n.width, 0) + nodeGap * Math.max(0, line.length - 1));
  const width = Math.max(320, ...widths) + margin * 2;
  let y = margin;
  lines.forEach((line, i) => {
    if (i > 0) y += nodeHeight + (firstOfLayer.has(i) ? layerGap : rowGap);
    let x = margin + (width - margin * 2 - widths[i]!) / 2;
    for (const n of line) {
      n.x = x;
      n.y = y;
      x += n.width + nodeGap;
    }
  });
  const cycles = [...size]
    .filter(([, n]) => n > 1)
    .map(([c]) => nodes.filter((n) => n.component === c).map((n) => n.label))
    .sort((a, b) => b.length - a.length || (a[0]! < b[0]! ? -1 : 1));
  edges.sort((a, b) => b.pairs - a.pairs || (a.source < b.source ? -1 : a.source > b.source ? 1 : a.target < b.target ? -1 : 1));
  return { nodes, edges, cycles, layers, width, height: y + nodeHeight + margin };
}
