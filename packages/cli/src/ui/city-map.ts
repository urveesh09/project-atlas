import type { ArtifactCore, GraphSnapshot } from '@atlas/schema';

/** What the CLI reads to report an artifact: validated core plus the selected frame. */
export type ArtifactView = ArtifactCore & { head: GraphSnapshot };
import { PALETTE, lighten, type Styler } from './style.js';

/**
 * A top-down terminal rendering of the artifact's own layout chunk: the same integer
 * districts and plots the 3D city will use, drawn with half-block characters so each
 * character cell holds two square pixels. Nothing here is decorative data: every colored
 * pixel is a district or a file plot from layout/layout.json.gz.
 */
export interface CityMap {
  lines: string[];
  /** Top-level districts in drawing order, with the color used for each. */
  districts: { label: string; color: string; files: number }[];
  roles: { role: string; color: string; count: number }[];
  pixelsPerCell: number;
}

type Pixel = string | null;

export function renderCityMap(bundle: ArtifactView, s: Styler, options: { maxWidth: number; maxRows: number }): CityMap {
  const { layout } = bundle;
  const graph = bundle.head;
  const frame = layout.frameState.at(-1)!;
  const unit = layout.unitsPerCell;
  const widthCells = layout.root.width / unit;
  const depthCells = layout.root.depth / unit;
  const pixelsPerCell = Math.min(3, options.maxWidth / widthCells, (options.maxRows * 2) / depthCells);
  const pxW = Math.max(1, Math.round(widthCells * pixelsPerCell));
  const pxH = Math.max(2, Math.round(depthCells * pixelsPerCell));
  const grid: Pixel[][] = Array.from({ length: pxH }, () => new Array<Pixel>(pxW).fill(PALETTE.ground));

  const span = (start: number, size: number, limit: number): [number, number] => {
    const a = Math.min(limit - 1, Math.floor((start / unit) * pixelsPerCell));
    const b = Math.min(limit, Math.max(a + 1, Math.floor(((start + size) / unit) * pixelsPerCell)));
    return [a, b];
  };
  const fill = (rect: { x: number; z: number; width: number; depth: number }, color: string) => {
    const [x0, x1] = span(rect.x, rect.width, pxW);
    const [z0, z1] = span(rect.z, rect.depth, pxH);
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) grid[z]![x] = color;
  };

  // District depth from the parent chain; package-level districts get distinct hues.
  const byId = new Map(layout.districts.map((d) => [d.id, d]));
  const depthOf = (id: string): number => {
    let depth = 0;
    for (let p = byId.get(id)?.parentId ?? null; p; p = byId.get(p)?.parentId ?? null) depth++;
    return depth;
  };
  const topOf = (id: string): string | null => {
    let current = byId.get(id);
    while (current && current.parentId && byId.get(current.parentId)?.parentId) current = byId.get(current.parentId);
    return current && current.parentId ? current.id : null;
  };
  const tops = layout.districts.filter((d) => d.parentId !== null && byId.get(d.parentId)?.parentId === null).sort((a, b) => a.rect.z - b.rect.z || a.rect.x - b.rect.x);
  const topColor = new Map(tops.map((d, i) => [d.id, PALETTE.districts[i % PALETTE.districts.length]!]));
  const ordered = [...layout.districts].sort((a, b) => depthOf(a.id) - depthOf(b.id));
  for (const district of ordered) {
    const depth = depthOf(district.id);
    if (depth === 0) continue;
    const base = topColor.get(topOf(district.id) ?? district.id) ?? PALETTE.road;
    fill(district.rect, depth === 1 ? base : lighten(base, Math.min(0.45, 0.1 * (depth - 1))));
  }

  // Buildings, colored by file role.
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const roleOfLineage = new Map(frame.files.map((f) => {
    const node = nodes.get(f.nodeId);
    return [f.lineageId, node?.kind === 'file' ? node.role : 'opaque'];
  }));
  const roleCounts = new Map<string, number>();
  const filesPerTop = new Map<string, number>();
  for (const plot of layout.plots) {
    const role = roleOfLineage.get(plot.lineageId) ?? 'opaque';
    roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    const top = topOf(plot.districtId) ?? plot.districtId;
    filesPerTop.set(top, (filesPerTop.get(top) ?? 0) + 1);
    fill(plot.rect, PALETTE.roles[role] ?? PALETTE.roles['opaque']!);
  }

  const lines: string[] = [];
  for (let z = 0; z < pxH; z += 2) {
    let line = '';
    for (let x = 0; x < pxW; x++) {
      const top = grid[z]![x]!;
      const bottom = z + 1 < pxH ? grid[z + 1]![x]! : null;
      if (s.level === 0) line += asciiPixel(top, bottom);
      else if (bottom === null) line += s.fg(top, s.unicode ? '▀' : '#');
      else if (top === bottom) line += s.bg(top, ' ');
      else line += s.pair(top, bottom, s.unicode ? '▀' : '#');
    }
    lines.push(line);
  }

  const labelOf = (id: string) => {
    const district = byId.get(id)!;
    const pkg = graph.nodes.find((n) => n.kind === 'package' && n.path === district.anchorPath);
    if (pkg && pkg.kind === 'package') return pkg.packageName ?? (pkg.path === '' ? `${pkg.label} (root)` : pkg.path);
    return district.anchorPath || '(root)';
  };
  return {
    lines,
    districts: tops.map((d) => ({ label: labelOf(d.id), color: topColor.get(d.id)!, files: filesPerTop.get(d.id) ?? 0 })),
    roles: ['source', 'test', 'config', 'declaration', 'asset', 'opaque']
      .filter((role) => roleCounts.has(role))
      .map((role) => ({ role, color: PALETTE.roles[role]!, count: roleCounts.get(role)! })),
    pixelsPerCell,
  };
}

/** Monochrome fallback: buildings, districts and roads as distinct glyph densities. */
function asciiPixel(top: Pixel, bottom: Pixel): string {
  const pick = (p: Pixel) => (p === null || p === PALETTE.ground ? 0 : Object.values(PALETTE.roles).includes(p) ? 3 : 1);
  const v = Math.max(pick(top), pick(bottom));
  return v === 3 ? '#' : v === 1 ? '.' : ' ';
}
