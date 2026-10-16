import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInventory, classifyPath, compileGlob, hasGeneratedHeader, normalizeOptions, parseRepositoryConfig, type Inventory } from '@atlas/analyzer-core';
import { openLocalRepository, readCommit, type SafeGit } from '@atlas/ingest';
import { compareUtf8 } from '@atlas/schema';
import { buildInventoryFixture, type InventoryFixture } from '@atlas/test-fixtures';

let fixture: InventoryFixture;
let git: SafeGit;
let tree: string;

async function inventoryWith(overrides: { includedFiles?: number; headDecodedSourceBytes?: number; treeEntries?: number; cliExclude?: string[] } = {}): Promise<Inventory> {
  const { cliExclude = [], ...limits } = overrides;
  const options = normalizeOptions({ limits });
  return buildInventory(git, tree, { limits: options.limits, repositoryExclude: ['docs/generated/'], cliExclude });
}

beforeAll(async () => {
  fixture = buildInventoryFixture();
  ({ git } = await openLocalRepository(fixture.repo.dir));
  tree = (await readCommit(git, fixture.head)).tree;
});
afterAll(async () => {
  await git?.dispose();
  fixture?.repo.dispose();
});

describe('committed inventory matches hand-written expectations (P1.2)', () => {
  let inventory: Inventory;
  beforeAll(async () => {
    inventory = await inventoryWith();
  });

  it('accounts for every tree entry exactly once', () => {
    expect(inventory.discovered).toBe(fixture.entries.length);
    expect(inventory.files.length + inventory.excluded.length + inventory.omitted.length).toBe(inventory.discovered);
  });

  it('includes exactly the expected files, in canonical UTF-8 order', () => {
    const expected = fixture.entries
      .filter((e) => e.expected.status !== 'excluded')
      .map((e) => e.entry.path as string)
      .sort(compareUtf8);
    expect(inventory.files.map((f) => f.path)).toEqual(expected);
  });

  it.each(buildInventoryFixtureEntriesForTable())('%s', (label, expected) => {
    if (expected.status === 'excluded') {
      const match = inventory.excluded.filter((x) => (x.path ?? '') === (typeof label === 'string' && !label.includes('<') && !label.includes('\\n') ? label : ''));
      expect(match.map((m) => m.reason), `${label}`).toContain(expected.reason);
      return;
    }
    const file = inventory.files.find((f) => f.path === label)!;
    expect(file, label).toBeDefined();
    expect(file.role).toBe(expected.role);
    if (expected.status === 'supported') {
      expect(file.supported).toBe(true);
      expect(file.language).toBe(expected.language);
      expect(file.text).not.toBeNull();
      expect(file.opaqueReason).toBeNull();
    } else {
      expect(file.supported).toBe(false);
      if (expected.reason && expected.reason !== 'LANGUAGE_UNSUPPORTED' && expected.reason !== 'LOCKFILE_STRUCTURAL') expect(file.opaqueReason).toBe(expected.reason);
      else expect(file.opaqueReason).toBeNull();
      if (expected.reason) expect(inventory.reasons.get(expected.reason)).toBeGreaterThan(0);
    }
  });

  it('records blob hashes for read content and strips a UTF-8 BOM', () => {
    const bom = inventory.files.find((f) => f.path === 'BOM.ts')!;
    expect(bom.text).toBe('export const bom = 1;\n');
    expect(bom.blobSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(inventory.files.find((f) => f.path === 'assets/logo.png')!.blobSha256).not.toBeNull(); // small file probed for LFS
    expect(inventory.files.find((f) => f.path === 'src/huge.ts')!.blobSha256).toBeNull(); // never read
  });

  it('names excluded directory roots for reporting', () => {
    expect(inventory.excludedRoots.get('node_modules')).toEqual({ reason: 'DEPENDENCY_DIRECTORY', count: 1 });
    expect(inventory.excludedRoots.get('packages/a/node_modules')).toEqual({ reason: 'DEPENDENCY_DIRECTORY', count: 1 });
    expect(inventory.excludedRoots.get('dist')).toEqual({ reason: 'BUILD_OUTPUT', count: 1 });
    expect(inventory.excludedRoots.get('docs/generated')).toEqual({ reason: 'REPOSITORY_EXCLUDED', count: 1 });
  });

  it('is deterministic', async () => {
    const again = await inventoryWith();
    expect(again.files.map((f) => [f.path, f.role, f.supported, f.opaqueReason, f.blobSha256])).toEqual(inventory.files.map((f) => [f.path, f.role, f.supported, f.opaqueReason, f.blobSha256]));
    expect([...again.reasons]).toEqual([...inventory.reasons]);
  });
});

function buildInventoryFixtureEntriesForTable(): [string, InventoryFixture['entries'][number]['expected']][] {
  // Evaluated at collection time without Git: the expectations table only.
  return fixtureTable();
}

import { inventoryFixtureEntries } from '@atlas/test-fixtures';
function fixtureTable(): [string, InventoryFixture['entries'][number]['expected']][] {
  return inventoryFixtureEntries('0'.repeat(40)).map((e) => [e.label ?? (e.entry.path as string), e.expected]);
}

describe('limits produce explicit, deterministic omissions', () => {
  it('omits files beyond the included-file limit in canonical order', async () => {
    const inventory = await inventoryWith({ includedFiles: 5 });
    expect(inventory.files).toHaveLength(5);
    expect(inventory.limitsHit.has('FILE_LIMIT')).toBe(true);
    expect(inventory.reasons.get('FILE_LIMIT')).toBe(inventory.omitted.length);
    const full = await inventoryWith();
    expect(inventory.files.map((f) => f.path)).toEqual(full.files.slice(0, 5).map((f) => f.path));
    expect(inventory.files.length + inventory.excluded.length + inventory.omitted.length).toBe(inventory.discovered);
  });

  it('turns code beyond the decoded-source budget into opaque files', async () => {
    const inventory = await inventoryWith({ headDecodedSourceBytes: 60 });
    expect(inventory.limitsHit.has('SOURCE_BUDGET')).toBe(true);
    expect(inventory.files.filter((f) => f.supported).reduce((a, f) => a + f.byteSize, 0)).toBeLessThanOrEqual(60);
    expect(inventory.files.some((f) => f.opaqueReason === 'SOURCE_BUDGET')).toBe(true);
  });

  it('aborts the snapshot when the tree exceeds the entry cap', async () => {
    await expect(inventoryWith({ treeEntries: 10 })).rejects.toMatchObject({ code: 'ANALYSIS_RESOURCE_LIMIT' });
  });

  it('applies CLI exclusions after repository configuration', async () => {
    const inventory = await inventoryWith({ cliExclude: ['*.css'] });
    expect(inventory.excluded).toContainEqual({ path: 'src/styles.css', reason: 'CLI_EXCLUDED' });
  });
});

describe('exclusion globs', () => {
  it.each([
    ['node_modules/', 'node_modules/a.js', true],
    ['node_modules/', 'x/node_modules/a/b.js', true],
    ['node_modules/', 'node_modules', false],
    ['node_modules/', 'my_node_modules/a.js', false],
    ['*.min.js', 'a/b/c.min.js', true],
    ['*.min.js', 'a/min.js', false],
    ['/docs', 'docs/a.md', true],
    ['/docs', 'src/docs/a.md', false],
    ['docs/generated/', 'docs/generated/x.ts', true],
    ['docs/generated/', 'src/docs/generated/x.ts', false],
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['src/**/*.ts', 'src/c.ts', true],
    ['src/**/*.ts', 'lib/c.ts', false],
    ['fixture?.json', 'a/fixture1.json', true],
  ])('%s vs %s → %s', (pattern, path, expected) => {
    expect(compileGlob(pattern)!.test(path)).toBe(expected);
  });

  it.each(['', '!negated', 'a/../b', '{a,b}', '[ab]', 'back\\slash', 'x'.repeat(300)])('rejects unsupported pattern %j', (pattern) => {
    expect(compileGlob(pattern)).toBeNull();
  });
});

describe('classification helpers', () => {
  it.each([
    ['src/a.ts', 'source'],
    ['src/__tests__/a.ts', 'test'],
    ['e2e/flow.spec.ts', 'test'],
    ['lib/a.d.mts', 'declaration'],
    ['next.config.mjs', 'config'],
    ['.eslintrc.cjs', 'config'],
    ['tsconfig.build.json', 'config'],
    ['data/cities.json', 'asset'],
    ['fonts/a.woff2', 'asset'],
    ['Makefile', 'opaque'],
    ['scripts/run.sh', 'opaque'],
    // Python (ADR-060): pytest's discovery names are tests, stubs are declarations.
    ['scripts/run.py', 'source'],
    ['src/pkg/__init__.py', 'source'],
    ['tests/helpers.py', 'test'],
    ['pkg/test_models.py', 'test'],
    ['pkg/models_test.py', 'test'],
    ['conftest.py', 'test'],
    ['pkg/testing.py', 'source'],
    ['pkg/models.pyi', 'declaration'],
    ['pyproject.toml', 'config'],
    ['setup.py', 'config'],
    ['requirements-dev.txt', 'config'],
    ['notebooks/explore.ipynb', 'opaque'],
  ])('%s is %s', (path, role) => {
    expect(classifyPath(path).role).toBe(role);
  });

  it('marks Python as a parse candidate and lockfiles as lockfiles', () => {
    expect(classifyPath('pkg/models.py')).toMatchObject({ language: 'python', code: true });
    expect(classifyPath('pkg/models.pyi')).toMatchObject({ language: 'python', code: true, role: 'declaration' });
    expect(classifyPath('ext/fast.pyx')).toMatchObject({ language: null, code: false, unsupportedLanguage: true });
    expect(classifyPath('poetry.lock').lockfile).toBe(true);
    expect(classifyPath('uv.lock').lockfile).toBe(true);
    expect(classifyPath('src/a.ts').language).toBe('typescript');
  });

  it('detects generated headers only in leading comments', () => {
    expect(hasGeneratedHeader('// Code generated by tool. DO NOT EDIT.\nexport {};')).toBe(true);
    expect(hasGeneratedHeader('/**\n * @generated\n */\nexport {};')).toBe(true);
    expect(hasGeneratedHeader("export const note = '@generated';")).toBe(false);
    expect(hasGeneratedHeader('// handwritten\nconst x = 1; // DO NOT EDIT')).toBe(false);
    // Python headers are `#` comments (ADR-060); `//` is not a Python comment.
    expect(hasGeneratedHeader('# -*- coding: utf-8 -*-\n# Generated by the protocol buffer compiler.  DO NOT EDIT!\nimport x\n', true)).toBe(true);
    expect(hasGeneratedHeader('#!/usr/bin/env python\n# @generated\n', true)).toBe(true);
    expect(hasGeneratedHeader('"""DO NOT EDIT"""\nimport x\n', true)).toBe(false);
    expect(hasGeneratedHeader('import x  # DO NOT EDIT\n', true)).toBe(false);
    expect(hasGeneratedHeader('// DO NOT EDIT\n', true)).toBe(false);
  });

  it('validates atlas.config.json as data', () => {
    expect(parseRepositoryConfig('{"version":1,"exclude":["a/","b/**"]}').exclude).toEqual(['a/', 'b/**']);
    expect(parseRepositoryConfig('{"version":2}').warnings[0]!.code).toBe('ATLAS_CONFIG_UNSUPPORTED_VERSION');
    expect(parseRepositoryConfig('{"version":1,"plugins":["x"]}').warnings[0]!.code).toBe('ATLAS_CONFIG_UNKNOWN_KEY');
    expect(parseRepositoryConfig('{"version":1,"exclude":["!x"]}').warnings[0]!.code).toBe('ATLAS_CONFIG_PATTERN_UNSUPPORTED');
    expect(parseRepositoryConfig('not json').warnings[0]!.code).toBe('ATLAS_CONFIG_INVALID');
  });

  it('only lowers limits', () => {
    expect(() => normalizeOptions({ limits: { includedFiles: 20_000 } })).toThrow(/not raised/);
    expect(() => normalizeOptions({ history: { enabled: true, snapshots: 13 } })).toThrow(/--snapshots/);
    expect(normalizeOptions({ limits: { includedFiles: 10 } }).limits.includedFiles).toBe(10);
  });
});
