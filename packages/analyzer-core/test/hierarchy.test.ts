import { describe, expect, it } from 'vitest';
import { buildHierarchy, type Inventory, type InventoryFile } from '@atlas/analyzer-core';
import { classifyPath } from '@atlas/analyzer-core';
import { compareUtf8, type GraphNode } from '@atlas/schema';

/**
 * Package/config discovery (task P1.3). The inventory is built in memory so this test
 * isolates hierarchy rules; the Git path is covered by inventory and CLI tests.
 */
const json = (v: unknown) => JSON.stringify(v);

const files: Record<string, string> = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - apps/**   # nested apps\n  - '!packages/ignored'\n",
  'package.json': json({ name: 'mono', private: true, dependencies: { lodash: '^4.17.21' }, devDependencies: { typescript: '6.0.3' } }),
  'tsconfig.json': json({ extends: './tsconfig.base.json', files: [], references: [{ path: 'packages/core' }] }),
  'tsconfig.base.json': json({ extends: '@tsconfig/strictest/tsconfig.json' }),
  'README.md': '# mono',
  'tools/script.ts': 'export {};',
  'packages/core/package.json': json({ name: '@m/core', dependencies: { '@m/utils': 'workspace:*', zod: '^4.0.0' } }),
  'packages/core/tsconfig.json': json({ compilerOptions: { composite: true }, references: [{ path: '../utils' }] }),
  'packages/core/src/index.ts': 'export {};',
  'packages/utils/package.json': json({ name: '@m/utils', peerDependencies: { zod: '^3.0.0' } }),
  'packages/utils/tsconfig.json': json({ compilerOptions: { composite: true, plugins: [{ name: 'evil-plugin' }] } }),
  'packages/utils/index.ts': 'export {};',
  'packages/ignored/package.json': json({ name: '@m/ignored' }),
  'packages/ignored/x.ts': 'export {};',
  'packages/dup/package.json': json({ name: '@m/utils' }),
  'packages/dup/y.ts': 'export {};',
  'apps/web/client/package.json': json({ name: '@m/client', dependencies: { '@m/core': 'workspace:*', react: '^19.0.0' } }),
  'apps/web/client/src/main.tsx': 'export {};',
  'broken/tsconfig.json': json({ extends: './tsconfig.json' }),
  'broken/b.ts': 'export {};',
  'dual/tsconfig.json': json({ compilerOptions: { allowJs: true } }),
  'dual/jsconfig.json': json({ compilerOptions: { allowJs: true } }),
  'dual/a.ts': 'export {};',
};

function inventoryOf(input: Record<string, string>): Inventory {
  const list: InventoryFile[] = Object.entries(input)
    .map(([path, text]) => {
      const cls = classifyPath(path);
      return { path, blobOid: 'a'.repeat(40), blobSha256: null, byteSize: text.length, role: cls.role, language: cls.language, supported: cls.code, opaqueReason: null, text };
    })
    .sort((a, b) => compareUtf8(a.path, b.path));
  return { files: list, excluded: [], omitted: [], discovered: list.length, reasons: new Map(), limitsHit: new Set(), excludedRoots: new Map(), decodedSourceBytes: 0 };
}

const SNAP = `snap_${'1'.repeat(64)}`;
const result = buildHierarchy({ snapshotId: SNAP, repoDisplayName: 'mono-repo', inventory: inventoryOf(files), lineageOf: (p) => `lin_${'0'.repeat(63)}${p.length % 10}` });
const byId = new Map(result.nodes.map((n) => [n.id, n]));
const pathOf = (n: GraphNode | undefined): string => (n === undefined ? '?' : n.kind === 'repository' ? '<repo>' : n.kind === 'package' ? `pkg:${n.path}` : n.kind === 'directory' ? `dir:${n.path}` : n.kind === 'file' ? n.path : n.label);

describe('package and directory hierarchy (P1.3)', () => {
  it('creates the root package plus recognized workspace members as top-level districts', () => {
    const packages = result.nodes.flatMap((n) => (n.kind === 'package' ? [[n.path, n.packageName, n.workspace, pathOf(byId.get(n.parentId!))]] : [])).sort();
    expect(packages).toEqual([
      ['', 'mono', true, '<repo>'],
      ['apps/web/client', '@m/client', true, '<repo>'],
      ['packages/core', '@m/core', true, '<repo>'],
      ['packages/dup', '@m/utils', true, '<repo>'],
      ['packages/utils', '@m/utils', true, '<repo>'],
    ]);
  });

  it('keeps folders exactly, without duplicating package paths', () => {
    const dirs = result.nodes.flatMap((n) => (n.kind === 'directory' ? [`${n.path} <- ${pathOf(byId.get(n.parentId!))}`] : [])).sort();
    expect(dirs).toEqual([
      'apps/web/client/src <- pkg:apps/web/client',
      'broken <- pkg:',
      'dual <- pkg:',
      'packages <- pkg:',
      'packages/core/src <- pkg:packages/core',
      'packages/ignored <- dir:packages',
      'tools <- pkg:',
    ]);
  });

  it('parents every file by its directory (non-member manifests stay inside the root package)', () => {
    const parents = Object.fromEntries(result.nodes.flatMap((n) => (n.kind === 'file' ? [[n.path, pathOf(byId.get(n.parentId!))]] : [])));
    expect(parents['packages/ignored/x.ts']).toBe('dir:packages/ignored');
    expect(parents['packages/utils/index.ts']).toBe('pkg:packages/utils');
    expect(parents['README.md']).toBe('pkg:');
    expect(parents['apps/web/client/src/main.tsx']).toBe('dir:apps/web/client/src');
    expect(Object.keys(parents)).toHaveLength(Object.keys(files).length);
  });

  it('records declared dependencies as declares-package edges, never guessing an ambiguous name', () => {
    const edges = result.edges
      .filter((e) => e.kind === 'declares-package')
      .map((e) => `${pathOf(byId.get(e.sourceId))} -> ${pathOf(byId.get(e.targetId))} x${e.observationCount}`)
      .sort();
    expect(edges).toEqual([
      'pkg: -> lodash x1',
      'pkg: -> typescript x1',
      'pkg:apps/web/client -> pkg:packages/core x1',
      'pkg:apps/web/client -> react x1',
      'pkg:packages/core -> zod x1',
      'pkg:packages/utils -> zod x1',
    ]);
    const zod = result.nodes.find((n) => n.kind === 'external-package' && n.packageName === 'zod');
    expect(zod?.kind === 'external-package' && zod.declaredRanges.map((r) => [pathOf(byId.get(r.packageNodeId)), r.field, r.range]).sort()).toEqual([
      ['pkg:packages/core', 'dependencies', '^4.0.0'],
      ['pkg:packages/utils', 'peerDependencies', '^3.0.0'],
    ]);
  });

  it('records project references between packages', () => {
    const refs = result.edges.filter((e) => e.kind === 'project-reference').map((e) => `${pathOf(byId.get(e.sourceId))} -> ${pathOf(byId.get(e.targetId))}`).sort();
    expect(refs).toEqual(['pkg: -> pkg:packages/core', 'pkg:packages/core -> pkg:packages/utils']);
  });

  it('reports configuration problems as coverage warnings', () => {
    const codes = result.warnings.map((w) => `${w.code} ${w.path ?? ''}`).sort();
    expect(codes).toEqual(
      expect.arrayContaining([
        'CONFIG_EXTENDS_CYCLE broken/tsconfig.json',
        'CONFIG_EXTENDS_EXTERNAL tsconfig.json',
        'CONFIG_PLUGINS_IGNORED packages/utils/tsconfig.json',
        'AMBIGUOUS_WORKSPACE_DEPENDENCY packages/core/package.json',
        'DUPLICATE_WORKSPACE_PACKAGE_NAME packages/dup/package.json',
        'DUPLICATE_WORKSPACE_PACKAGE_NAME packages/utils/package.json',
        'MULTIPLE_PROJECT_CONTEXTS dual/a.ts',
      ]),
    );
  });

  it('creates a synthetic root package when there is no root manifest', () => {
    const bare = buildHierarchy({ snapshotId: SNAP, repoDisplayName: 'loose', inventory: inventoryOf({ 'a.ts': '', 'lib/b.ts': '' }), lineageOf: () => `lin_${'2'.repeat(64)}` });
    const root = bare.nodes.find((n) => n.kind === 'package');
    expect(root).toMatchObject({ path: '', manifestPath: null, packageName: null, workspace: false, label: 'loose' });
    expect(bare.edges).toEqual([]);
  });
});
