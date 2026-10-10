import {
  compareAscii,
  type FileNode,
  type FileRole,
  type GraphSnapshot,
  type LayoutArtifact,
  type NodeMetrics,
  type Rect,
} from '@atlas/schema';

export type CityLens = 'structure' | 'complexity' | 'fan-in';
export const CITY_LENSES = ['structure', 'complexity', 'fan-in'] as const;
export const DISTRICT_PALETTE = ['#78a9ac', '#d9ad73', '#9c94bf', '#8fb894', '#cf91a0', '#84a9ce'] as const;
export const METRIC_PALETTE = ['#b9d7da', '#7dbbc6', '#478baf', '#496891', '#785688'] as const;
export const UNKNOWN_COLOR = '#aeb4bc';
export const LENS_STOPS = { complexity: [0, 5, 10, 20, 40], 'fan-in': [0, 1, 5, 10, 25] } as const;

export interface CityBuilding {
  nodeId: string;
  lineageId: string;
  districtId: string;
  path: string;
  role: FileRole;
  parseStatus: FileNode['parseStatus'];
  rect: Rect;
  height: number;
  seed: number;
  packageId: string | null;
  packageColor: string;
  metric: NodeMetrics | null;
}
export interface CityData {
  root: Rect;
  buildings: CityBuilding[];
  districts: {
    id: string;
    rect: Rect;
    depth: number;
    path: string;
    nodeId: string | null;
    kind: string;
    label: string;
  }[];
  terminals: { name: string; nodeId: string; x: number; z: number }[];
  allTerminals: { name: string; nodeId: string; x: number; z: number }[];
  terminalOmitted: number;
}

/** Pure projection of an already validated bundle. No coordinate or ID invention. */
export function prepareCity(graph: GraphSnapshot, layout: LayoutArtifact): CityData {
  const frame = layout.frameState.find((f) => f.snapshotId === graph.snapshotId);
  if (!frame) throw new Error('The active snapshot has no layout membership');
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const metrics = new Map(graph.metrics.map((m) => [m.nodeId, m]));
  const plots = new Map(layout.plots.map((p) => [p.lineageId, p]));
  const containers = new Map(
    frame.containers.filter((c) => c.layoutDistrictId).map((c) => [c.layoutDistrictId!, nodes.get(c.graphNodeId)]),
  );
  const districtOf = new Map(frame.containers.map((c) => [c.graphNodeId, c.layoutDistrictId]));
  const districtsById = new Map(layout.districts.map((d) => [d.id, d]));
  const packageOf = new Map<string, string | null>();
  const findPackage = (id: string): string | null => {
    const chain: string[] = [];
    let current = nodes.get(id);
    while (current && current.kind !== 'package' && !packageOf.has(current.id)) {
      chain.push(current.id);
      current = current.parentId ? nodes.get(current.parentId) : undefined;
    }
    const pkg = current?.kind === 'package' ? current.id : current ? (packageOf.get(current.id) ?? null) : null;
    for (const key of chain) packageOf.set(key, pkg);
    return pkg;
  };
  const colorOf = (id: string) => DISTRICT_PALETTE[parseInt(id.slice(-8), 16) % DISTRICT_PALETTE.length]!;
  const buildings = frame.files
    .map((file): CityBuilding => {
      const node = nodes.get(file.nodeId);
      const plot = plots.get(file.lineageId);
      if (node?.kind !== 'file' || !plot) throw new Error('Layout membership disagrees with the graph');
      const packageId = findPackage(node.id);
      return {
        nodeId: node.id,
        lineageId: file.lineageId,
        districtId: plot.districtId,
        path: node.path,
        role: node.role,
        parseStatus: node.parseStatus,
        rect: plot.rect,
        height: file.height,
        seed: plot.seed,
        packageId,
        packageColor: colorOf((packageId && districtOf.get(packageId)) || plot.districtId),
        metric: metrics.get(node.id) ?? null,
      };
    })
    .sort((a, b) => compareAscii(a.lineageId, b.lineageId));
  const districts = layout.districts
    .map((d) => {
      let depth = 0;
      let parent = d.parentId;
      while (parent) {
        depth++;
        parent = districtsById.get(parent)?.parentId ?? null;
      }
      const node = containers.get(d.id);
      return {
        id: d.id,
        rect: d.rect,
        depth,
        path: d.anchorPath,
        nodeId: node?.id ?? null,
        kind: node?.kind ?? 'directory',
        label: node?.kind === 'package' ? (node.packageName ?? (node.path || node.label)) : d.anchorPath,
      };
    })
    .sort((a, b) => a.depth - b.depth || compareAscii(a.id, b.id));
  const externalNodes = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind === 'external-package') externalNodes.set(`npm:${n.packageName}`, n.id);
    else if (n.kind === 'builtin') externalNodes.set(`builtin:${n.moduleName}`, n.id);
  }
  const terminals = layout.externalAnchors.flatMap((a) =>
    externalNodes.has(a.canonicalName)
      ? [{ name: a.canonicalName, nodeId: externalNodes.get(a.canonicalName)!, x: a.x, z: a.z }]
      : [],
  );
  return {
    root: layout.root,
    buildings,
    districts,
    terminals:
      terminals.length <= 50
        ? terminals
        : Array.from({ length: 50 }, (_, i) => terminals[Math.floor((i * terminals.length) / 50)]!),
    allTerminals: terminals,
    terminalOmitted: Math.max(0, terminals.length - 50),
  };
}

export function lensValue(building: CityBuilding, lens: CityLens): number | null {
  if (lens === 'structure') return null;
  return lens === 'complexity' ? (building.metric?.maxCyclomatic ?? null) : (building.metric?.fanIn ?? null);
}
export function facadeColor(building: CityBuilding, lens: CityLens): string {
  if (lens === 'structure') return building.packageColor;
  const value = lensValue(building, lens);
  if (value === null) return UNKNOWN_COLOR;
  const stops = LENS_STOPS[lens];
  let band = 0;
  while (band + 1 < stops.length && value >= stops[band + 1]!) band++;
  return METRIC_PALETTE[band]!;
}

export type GateSide = 'north' | 'east' | 'south' | 'west';
export function districtGate(rect: Rect, target: { x: number; z: number }): { x: number; z: number; side: GateSide } {
  const cx = rect.x + rect.width / 2,
    cz = rect.z + rect.depth / 2;
  const dx = target.x - cx,
    dz = target.z - cz;
  // Absolute coordinate tie-break: north, east, south, west.
  const candidates = [
    { side: 'north' as const, score: -dz, x: cx, z: rect.z },
    { side: 'east' as const, score: dx, x: rect.x + rect.width, z: cz },
    { side: 'south' as const, score: dz, x: cx, z: rect.z + rect.depth },
    { side: 'west' as const, score: -dx, x: rect.x, z: cz },
  ];
  candidates.sort((a, b) => b.score - a.score);
  const gate = candidates[0]!;
  return { x: gate.x, z: gate.z, side: gate.side };
}

/** Raised polyline control points; the renderer smooths same-district quadratic arcs. */
export function routeDependency(
  root: Rect,
  source: { x: number; z: number; height: number; districtId: string },
  target: { x: number; z: number; height: number; districtId: string },
  districts: ReadonlyMap<string, Rect>,
): [number, number, number][] {
  const a: [number, number, number] = [source.x / 100, source.height + 0.45, source.z / 100];
  const b: [number, number, number] = [target.x / 100, target.height + 0.45, target.z / 100];
  const lift = Math.max(a[1], b[1]) + 2;
  if (source.x === target.x && source.z === target.z)
    return [a, [a[0] + 1, lift, a[2]], [a[0] + 1, lift, a[2] + 1], [b[0], lift, b[2] + 1], b];
  if (source.districtId === target.districtId) return [a, [(a[0] + b[0]) / 2, lift, (a[2] + b[2]) / 2], b];
  const sr = districts.get(source.districtId),
    tr = districts.get(target.districtId);
  const sg = sr ? districtGate(sr, target) : source,
    tg = tr ? districtGate(tr, source) : target;
  // Corridor lies on the root's north perimeter; it never purports to be a road/import.
  const corridorZ = (root.z - 300) / 100;
  return [
    a,
    [sg.x / 100, lift, sg.z / 100],
    [sg.x / 100, lift, corridorZ],
    [tg.x / 100, lift, corridorZ],
    [tg.x / 100, lift, tg.z / 100],
    b,
  ];
}
