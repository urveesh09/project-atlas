import { GraphIndex, POLICIES, type EdgePolicy } from '@atlas/graph';
import { routeDependency, type CityData } from '@atlas/layout';
import { compareAscii, type EdgeKind, type Rect } from '@atlas/schema';

export interface OverlayOptions {
  selectedId: string | null;
  direction: 'outgoing' | 'incoming' | 'both';
  includeTypes: boolean;
  pinnedEdgeId: string | null;
  packages: boolean;
}
export interface CityArc {
  id: string;
  sourceId: string;
  targetId: string;
  kind: EdgeKind | 'package';
  confidence: string;
  count: number;
  points: [number, number, number][];
}
export interface OverlayResult {
  key: string;
  selectionId: string | null;
  arcs: CityArc[];
  total: number;
  omitted: number;
  unplaced: number;
  policy: string;
  promotedTerminal: CityData['terminals'][number] | null;
}
export const overlayKey = (o: OverlayOptions) =>
  [o.selectedId ?? '', o.direction, o.includeTypes ? '1' : '0', o.pinnedEdgeId ?? '', o.packages ? '1' : '0'].join('|');
const lookups = new WeakMap<
  CityData,
  { buildings: Map<string, CityData['buildings'][number]>; districts: Map<string, Rect> }
>();
export function prepareOverlayLookup(city: CityData) {
  let value = lookups.get(city);
  if (!value) {
    value = {
      buildings: new Map(city.buildings.map((b) => [b.nodeId, b])),
      districts: new Map(city.districts.map((d) => [d.id, d.rect])),
    };
    lookups.set(city, value);
  }
  return value;
}
export const EDGE_COLORS = {
  value: '#15516b',
  type: '#754f92',
  dynamic: '#9b571e',
  resource: '#416244',
  package: '#15516b',
} as const;
export const edgeClass = (kind: string) =>
  kind === 'package'
    ? 'package'
    : kind.includes('type')
      ? 'type'
      : kind.includes('dynamic')
        ? 'dynamic'
        : kind.includes('resource')
          ? 'resource'
          : 'value';

/** Deterministic bounded render subset. All omitted relationships remain in the index. */
export function buildOverlay(index: GraphIndex, city: CityData, options: OverlayOptions): OverlayResult {
  const policy: EdgePolicy = options.includeTypes ? POLICIES.all : POLICIES.all.filter((k) => !k.includes('type'));
  const { buildings, districts } = prepareOverlayLookup(city);
  const terminalList = [...city.terminals];
  const pin = options.pinnedEdgeId ? index.snapshot.edges.find((e) => e.id === options.pinnedEdgeId) : undefined;
  const promotedTerminal = pin
    ? (city.allTerminals.find(
        (t) =>
          (t.nodeId === pin.sourceId || t.nodeId === pin.targetId) &&
          !terminalList.some((visible) => visible.nodeId === t.nodeId),
      ) ?? null)
    : null;
  if (promotedTerminal) {
    if (terminalList.length === 50) terminalList.pop();
    terminalList.push(promotedTerminal);
  }
  const terminals = new Map(terminalList.map((t) => [t.nodeId, t]));
  const pointOf = (id: string) => {
    const b = buildings.get(id);
    if (b)
      return {
        x: b.rect.x + b.rect.width / 2,
        z: b.rect.z + b.rect.depth / 2,
        height: b.height,
        districtId: b.districtId,
      };
    const t = terminals.get(id);
    if (t) return { x: t.x, z: t.z, height: 0.8, districtId: 'external' };
    return null;
  };
  const arcs: CityArc[] = [];
  let total = 0,
    unplaced = 0;
  if (!options.selectedId && options.packages) {
    const byNode = new Map(city.districts.filter((d) => d.kind === 'package' && d.nodeId).map((d) => [d.nodeId!, d]));
    for (const pair of index.packageRollups(policy)) {
      if (pair.sourcePackageId === pair.targetPackageId) continue;
      total++;
      const a = byNode.get(pair.sourcePackageId),
        b = byNode.get(pair.targetPackageId);
      if (!a || !b) {
        unplaced++;
        continue;
      }
      if (arcs.length >= 200) continue;
      arcs.push({
        id: `${a.id}:${b.id}`,
        sourceId: pair.sourcePackageId,
        targetId: pair.targetPackageId,
        kind: 'package',
        confidence: 'aggregate',
        count: pair.uniqueFilePairs,
        points: routeDependency(
          city.root,
          { x: a.rect.x + a.rect.width / 2, z: a.rect.z + a.rect.depth / 2, height: 1, districtId: a.id },
          { x: b.rect.x + b.rect.width / 2, z: b.rect.z + b.rect.depth / 2, height: 1, districtId: b.id },
          districts,
        ),
      });
    }
  } else if (options.selectedId && index.nodes.get(options.selectedId)?.kind === 'file') {
    const edges = [
      ...(options.direction === 'incoming' ? [] : index.outgoing(options.selectedId, policy)),
      ...(options.direction === 'outgoing' ? [] : index.incoming(options.selectedId, policy)),
    ];
    const ordered = [...new Map(edges.map((e) => [e.id, e])).values()].sort(
      (a, b) =>
        compareAscii(a.kind, b.kind) || compareAscii(a.sourceId, b.sourceId) || compareAscii(a.targetId, b.targetId),
    );
    total = ordered.length;
    // Pinning promotes an omitted edge while preserving the 200-edge hard cap.
    const pinned = ordered.find((e) => e.id === options.pinnedEdgeId);
    const candidates = pinned ? [pinned, ...ordered.filter((e) => e.id !== pinned.id)] : ordered;
    for (const e of candidates) {
      const a = pointOf(e.sourceId),
        b = pointOf(e.targetId);
      if (!a || !b) {
        unplaced++;
        continue;
      }
      if (arcs.length >= 200) continue;
      arcs.push({
        id: e.id,
        sourceId: e.sourceId,
        targetId: e.targetId,
        kind: e.kind,
        confidence: e.confidence,
        count: 1,
        points: routeDependency(city.root, a, b, districts),
      });
    }
  }
  return {
    key: overlayKey(options),
    selectionId: options.selectedId,
    arcs,
    total,
    omitted: Math.max(0, total - arcs.length),
    unplaced,
    promotedTerminal,
    policy: options.includeTypes
      ? 'All static observations, including type-only'
      : 'Value, dynamic and resource observations; type-only excluded',
  };
}
