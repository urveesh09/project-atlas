import { buildingHeight, computeLayout, xorshift32, type LayoutGeometry, type LayoutTreeNode } from '@atlas/layout';
import { lineageId, localRepositoryId } from '@atlas/schema';

/**
 * Synthetic city for the P0.4 rendering spike. This is a performance fixture, not an
 * analysis result: it exists only to measure instancing, picking and fallback behavior
 * at the supported size limit before the real viewer is built on real artifacts.
 */
export interface SyntheticBuilding {
  lineageId: string;
  x: number;
  z: number;
  height: number;
  district: number;
}

export interface SyntheticCity {
  geometry: LayoutGeometry;
  buildings: SyntheticBuilding[];
  districtDepth: Map<string, number>;
}

const REPO = localRepositoryId('00000000-0000-4000-8000-000000000000');

export function generateSyntheticCity(fileCount: number, seed = 7): SyntheticCity {
  const next = xorshift32(seed);
  const lines = new Map<string, number>();
  let created = 0;
  let serial = 0;
  const makeDir = (kind: LayoutTreeNode['kind'], path: string, depth: number, budget: number): LayoutTreeNode => {
    const node: LayoutTreeNode = { kind, path, files: [], children: [] };
    const direct = Math.min(budget, 4 + (next() % 24));
    for (let i = 0; i < direct && created < fileCount; i++, created++) {
      const id = lineageId(REPO, '0'.repeat(40), '0'.repeat(40), `${path}/file${serial++}.ts`);
      node.files.push(id);
      lines.set(id, next() % 100 < 8 ? 300 + (next() % 1500) : next() % 220);
    }
    let remaining = budget - direct;
    while (remaining > 0 && created < fileCount && depth < 5) {
      const share = Math.min(remaining, 10 + (next() % 120));
      node.children.push(makeDir('directory', `${path}/d${serial++}`, depth + 1, share));
      remaining -= share;
    }
    return node;
  };
  const packages = Math.max(1, Math.round(fileCount / 900));
  const per = Math.ceil(fileCount / packages);
  const root: LayoutTreeNode = { kind: 'repository', path: '', files: [], children: [] };
  for (let p = 0; p < packages && created < fileCount; p++) root.children.push(makeDir('package', `packages/p${p}`, 1, per));
  // Depth caps can leave budget unspent; top up with extra packages so the count is exact.
  for (let p = packages; created < fileCount; p++) root.children.push(makeDir('package', `packages/p${p}`, 1, fileCount - created));

  const geometry = computeLayout({ repoId: REPO, frameKey: `synthetic-${fileCount}-${seed}`, externals: [], root });
  const districtIndex = new Map(geometry.districts.map((d, i) => [d.id, i]));
  const depth = new Map<string, number>();
  const parentOf = new Map(geometry.districts.map((d) => [d.id, d.parentId]));
  for (const d of geometry.districts) {
    let n = 0;
    for (let p = d.parentId; p; p = parentOf.get(p) ?? null) n++;
    depth.set(d.id, n);
  }
  const buildings = geometry.plots.map((plot) => ({
    lineageId: plot.lineageId,
    x: plot.rect.x / geometry.unitsPerCell + 0.5,
    z: plot.rect.z / geometry.unitsPerCell + 0.5,
    height: buildingHeight('source', 'parsed', lines.get(plot.lineageId) ?? 0),
    district: districtIndex.get(plot.districtId) ?? 0,
  }));
  return { geometry, buildings, districtDepth: depth };
}
