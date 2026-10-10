import { UNITS_PER_CELL, compareAscii, districtId, makeId, type LayoutArtifact, type Rect } from '@atlas/schema';
import { seedFromId } from './prng.js';

/**
 * Hierarchical square-shelf packer, layout version 1 (plan §11.4). Pure and integer-only:
 * the same input always produces identical geometry on every platform. It is deliberately
 * not a semantic clustering or treemap algorithm.
 */
export const LAYOUT_CONSTANTS = Object.freeze({
  plotCells: 1,
  filePitch: 2,
  gutter: 2,
  border: 1,
  header: 2,
  emptyMarker: 4,
  perimeterRoad: 3,
  externalRing: 4,
  externalSpacing: 3,
});

export interface LayoutTreeNode {
  kind: 'repository' | 'package' | 'directory';
  /** Anchor path ('' for the repository and the synthetic root package). */
  path: string;
  children: LayoutTreeNode[];
  /** Lineage IDs whose layout anchor places them directly in this district. */
  files: string[];
}

export interface LayoutInput {
  repoId: string;
  root: LayoutTreeNode;
  /** Canonical perimeter names, e.g. `npm:react` or `builtin:fs`. */
  externals: string[];
  /** Included in the layout ID so different frame sets never share an ID. */
  frameKey: string;
}

export type LayoutGeometry = Pick<LayoutArtifact, 'layoutVersion' | 'layoutId' | 'unitsPerCell' | 'root' | 'districts' | 'plots' | 'externalAnchors'>;

interface Item {
  id: string;
  width: number;
  depth: number;
  /** Place this item (and its descendants) at an absolute cell origin. */
  place(x: number, z: number): void;
}

interface PlacedDistrict {
  id: string;
  parentId: string | null;
  anchorPath: string;
  rect: Rect;
}

interface PlacedPlot {
  lineageId: string;
  districtId: string;
  rect: Rect;
  seed: number;
}

function districtKind(node: LayoutTreeNode): 'repository' | 'package' | 'directory' {
  return node.kind;
}

/** Shelf-pack items in their given order; returns content size and relative offsets. */
function shelfPack(items: readonly Item[], gutter: number): { width: number; depth: number; offsets: { x: number; z: number }[] } {
  let maxChildWidth = 0;
  let paddedArea = 0;
  for (const item of items) {
    maxChildWidth = Math.max(maxChildWidth, item.width);
    paddedArea += (item.width + gutter) * (item.depth + gutter);
  }
  const target = Math.max(maxChildWidth, Math.ceil(Math.sqrt(paddedArea)));
  const offsets: { x: number; z: number }[] = [];
  let x = 0;
  let z = 0;
  let shelfDepth = 0;
  let shelfCount = 0;
  let width = 0;
  for (const item of items) {
    if (shelfCount > 0 && x + item.width > target) {
      z += shelfDepth + gutter;
      x = 0;
      shelfDepth = 0;
      shelfCount = 0;
    }
    offsets.push({ x, z });
    width = Math.max(width, x + item.width);
    x += item.width + gutter;
    shelfDepth = Math.max(shelfDepth, item.depth);
    shelfCount++;
  }
  return { width, depth: items.length === 0 ? 0 : z + shelfDepth, offsets };
}

export function computeLayout(input: LayoutInput): LayoutGeometry {
  const C = LAYOUT_CONSTANTS;
  const districts: PlacedDistrict[] = [];
  const plots: PlacedPlot[] = [];

  const build = (node: LayoutTreeNode, parentId: string | null): Item => {
    const id = districtId(input.repoId, districtKind(node), node.path);
    const items: Item[] = [];
    const files = [...node.files].sort(compareAscii);
    if (files.length > 0) {
      const columns = Math.ceil(Math.sqrt(files.length));
      const rows = Math.ceil(files.length / columns);
      const gridId = districtId(input.repoId, 'direct', node.path);
      items.push({
        id: gridId,
        width: (columns - 1) * C.filePitch + C.plotCells,
        depth: (rows - 1) * C.filePitch + C.plotCells,
        place: (x, z) => {
          files.forEach((lineageId, index) => {
            const col = index % columns;
            const row = Math.floor(index / columns);
            plots.push({
              lineageId,
              districtId: id,
              rect: { x: x + col * C.filePitch, z: z + row * C.filePitch, width: C.plotCells, depth: C.plotCells },
              seed: seedFromId(lineageId),
            });
          });
        },
      });
    }
    for (const child of node.children) items.push(build(child, id));
    items.sort((a, b) => b.width * b.depth - a.width * a.depth || Math.max(b.width, b.depth) - Math.max(a.width, a.depth) || compareAscii(a.id, b.id));

    const packed = shelfPack(items, C.gutter);
    const empty = items.length === 0;
    const width = empty ? C.emptyMarker : packed.width + 2 * C.border;
    const depth = empty ? C.emptyMarker : packed.depth + 2 * C.border + C.header;
    return {
      id,
      width,
      depth,
      place: (x, z) => {
        districts.push({ id, parentId, anchorPath: node.path, rect: { x, z, width, depth } });
        items.forEach((item, index) => item.place(x + C.border + packed.offsets[index]!.x, z + C.border + C.header + packed.offsets[index]!.z));
      },
    };
  };

  const rootItem = build(input.root, null);
  rootItem.place(0, 0);

  // External terminals: sorted canonical names, distributed N, E, S, W around a ring
  // outside the perimeter road, then scaled to units like everything else.
  const externals = [...new Set(input.externals)].sort(compareAscii);
  const ring = C.perimeterRoad + C.externalRing;
  const anchors = externals.map((canonicalName, index) => {
    const side = index % 4;
    const slot = Math.floor(index / 4);
    const along = slot * C.externalSpacing;
    switch (side) {
      case 0:
        return { canonicalName, x: along, z: -ring };
      case 1:
        return { canonicalName, x: rootItem.width + ring, z: along };
      case 2:
        return { canonicalName, x: rootItem.width - along, z: rootItem.depth + ring };
      default:
        return { canonicalName, x: -ring, z: rootItem.depth - along };
    }
  });

  const scale = (r: Rect): Rect => ({ x: r.x * UNITS_PER_CELL, z: r.z * UNITS_PER_CELL, width: r.width * UNITS_PER_CELL, depth: r.depth * UNITS_PER_CELL });
  const sortedDistricts = districts.map((d) => ({ ...d, rect: scale(d.rect) })).sort((a, b) => compareAscii(a.id, b.id));
  const sortedPlots = plots.map((p) => ({ ...p, rect: scale(p.rect) })).sort((a, b) => compareAscii(a.lineageId, b.lineageId));
  return {
    layoutVersion: 'atlas.layout/1.0.0',
    layoutId: makeId('layout', [input.repoId, input.frameKey, 'atlas.layout/1.0.0', sortedPlots.length]),
    unitsPerCell: UNITS_PER_CELL,
    root: scale({ x: 0, z: 0, width: rootItem.width, depth: rootItem.depth }),
    districts: sortedDistricts,
    plots: sortedPlots,
    externalAnchors: anchors.map((a) => ({ canonicalName: a.canonicalName, x: a.x * UNITS_PER_CELL, z: a.z * UNITS_PER_CELL })),
  };
}
