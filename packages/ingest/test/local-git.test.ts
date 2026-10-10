import { existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IngestError,
  batchCheck,
  diffTrees,
  discoverLocalRepository,
  isSimpleRefName,
  listTree,
  openLocalRepository,
  readCommit,
  readObjects,
  resolveLocalCommit,
  runBounded,
  type LocalRepository,
  type SafeGit,
} from '@atlas/ingest';
import { armExecutionTraps, commitRawTree, createGitFixture, runGit, type GitFixture } from '@atlas/test-fixtures';

const DATES = ['2026-08-01T10:00:00Z', '2026-08-02T10:00:00Z', '2026-08-03T10:00:00Z', '2026-08-04T10:00:00Z'];
const longBody = Array.from({ length: 40 }, (_, i) => `export const value${i} = ${i} * 2;`).join('\n');

let fixture: GitFixture;
let repo: LocalRepository;
let git: SafeGit;

beforeAll(async () => {
  fixture = createGitFixture([
    { date: DATES[0]!, message: 'root', files: { 'src/a.ts': longBody, 'README.md': '# demo\n' }, tag: { name: 'v1', annotated: true } },
    { date: DATES[1]!, message: 'rename', renames: [['src/a.ts', 'src/moved.ts']], branch: 'feature' },
    { date: DATES[2]!, message: 'rename and edit', renames: [['src/moved.ts', 'lib/final.ts']], files: { 'lib/final.ts': `${longBody}\nexport const extra = 1;\n`, 'src/new.ts': 'export {};\n' } },
    { date: DATES[3]!, message: 'delete', files: { 'README.md': null } },
  ]);
  ({ repo, git } = await openLocalRepository(fixture.dir));
});

afterAll(async () => {
  await git?.dispose();
  fixture?.dispose();
});

describe('local repository discovery', () => {
  it('finds the repository from a subdirectory and detects its layout', async () => {
    const found = await discoverLocalRepository(path.join(fixture.dir, 'src'));
    expect(found.objectFormat).toBe('sha1');
    expect(found.linkedWorktree).toBe(false);
    expect(found.reftable).toBe(false);
  });

  it('resolves HEAD, branches, annotated tags and full OIDs to commits', async () => {
    const [c0, c1, , c3] = fixture.commits;
    expect(await resolveLocalCommit(repo, git)).toBe(c3);
    expect(await resolveLocalCommit(repo, git, 'main')).toBe(c3);
    expect(await resolveLocalCommit(repo, git, 'feature')).toBe(c1);
    expect(await resolveLocalCommit(repo, git, 'v1')).toBe(c0);
    expect(await resolveLocalCommit(repo, git, c1)).toBe(c1);
  });

  it('resolves packed refs', async () => {
    const packed = createGitFixture([{ date: DATES[0]!, message: 'one', files: { a: '1' }, branch: 'packed-branch' }]);
    try {
      runGit(packed.dir, ['pack-refs', '--all']);
      const opened = await openLocalRepository(packed.dir);
      try {
        expect(await resolveLocalCommit(opened.repo, opened.git, 'packed-branch')).toBe(packed.commits[0]);
      } finally {
        await opened.git.dispose();
      }
    } finally {
      packed.dispose();
    }
  });

  it.each(['HEAD~1', 'main..feature', '--upload-pack=evil', '-x', 'a//b', 'refs/heads/main.lock', 'main@{0}', '.hidden', 'a b'])(
    'rejects revision expressions and option-like refs: %s',
    async (ref) => {
      expect(isSimpleRefName(ref)).toBe(false);
      await expect(resolveLocalCommit(repo, git, ref)).rejects.toMatchObject({ code: 'REF_INVALID' });
    },
  );

  it('reports unknown refs and empty repositories with stable codes', async () => {
    await expect(resolveLocalCommit(repo, git, 'does-not-exist')).rejects.toMatchObject({ code: 'REF_NOT_FOUND' });
    const empty = createGitFixture([]);
    try {
      const opened = await openLocalRepository(empty.dir);
      await expect(resolveLocalCommit(opened.repo, opened.git)).rejects.toMatchObject({ code: 'EMPTY_REPOSITORY' });
      await opened.git.dispose();
    } finally {
      empty.dispose();
    }
  });

  it('reads linked worktrees through their common object directory', async () => {
    const worktree = `${fixture.dir}-wt`;
    runGit(fixture.dir, ['worktree', 'add', '-q', worktree, 'feature']);
    try {
      const found = await discoverLocalRepository(worktree);
      expect(found.linkedWorktree).toBe(true);
      // Git can expand Windows 8.3 paths written in the worktree metadata.
      expect(await realpath(found.commonDir)).toBe(await realpath(path.join(fixture.dir, '.git')));
      const opened = await openLocalRepository(worktree);
      try {
        expect(await resolveLocalCommit(opened.repo, opened.git)).toBe(fixture.commits[1]);
      } finally {
        await opened.git.dispose();
      }
    } finally {
      runGit(fixture.dir, ['worktree', 'remove', '--force', worktree]);
    }
  });

  it('rejects object alternates', async () => {
    const borrower = createGitFixture([{ date: DATES[0]!, message: 'x', files: { a: '1' } }]);
    try {
      writeFileSync(path.join(borrower.dir, '.git', 'objects', 'info', 'alternates'), `${path.join(fixture.dir, '.git', 'objects')}\n`);
      await expect(discoverLocalRepository(borrower.dir)).rejects.toMatchObject({ code: 'LOCAL_OBJECT_STORE_UNSUPPORTED', details: { reason: 'ALTERNATES' } });
    } finally {
      borrower.dispose();
    }
  });

  it('reads SHA-256 repositories', async () => {
    const sha256 = createGitFixture([{ date: DATES[0]!, message: 'x', files: { 'a.ts': 'export {}' } }], { objectFormat: 'sha256' });
    try {
      const opened = await openLocalRepository(sha256.dir);
      try {
        expect(opened.repo.objectFormat).toBe('sha256');
        const head = await resolveLocalCommit(opened.repo, opened.git);
        expect(head).toHaveLength(64);
        const commit = await readCommit(opened.git, head);
        const tree = await listTree(opened.git, commit.tree, { maxEntries: 10 });
        expect(tree.entries.map((e) => e.path)).toEqual(['a.ts']);
      } finally {
        await opened.git.dispose();
      }
    } finally {
      sha256.dispose();
    }
  });
});

describe('committed object reading', () => {
  it('parses commits without retaining identities or messages', async () => {
    const commit = await readCommit(git, fixture.commits[1]!);
    expect(commit.parents).toEqual([fixture.commits[0]]);
    expect(commit.committerEpochSeconds).toBe(Date.parse(DATES[1]!) / 1000);
    expect(JSON.stringify(commit)).not.toMatch(/fixture@atlas\.invalid|ATLAS Fixture|rename/);
  });

  it('lists the committed tree, not the working tree', async () => {
    writeFileSync(path.join(fixture.dir, 'uncommitted.ts'), 'export const dirty = true;');
    try {
      const commit = await readCommit(git, fixture.commits[3]!);
      const tree = await listTree(git, commit.tree, { maxEntries: 100 });
      expect(tree.entries.map((e) => e.path)).toEqual(['lib/final.ts', 'src/new.ts']);
      const blobs = await readObjects(git, tree.entries.map((e) => ({ oid: e.oid, size: e.size! })));
      expect(blobs.get(tree.entries[1]!.oid)!.bytes.toString()).toBe('export {};\n');
    } finally {
      rmSync(path.join(fixture.dir, 'uncommitted.ts'));
    }
  });

  it('enforces the entry cap', async () => {
    const commit = await readCommit(git, fixture.commits[2]!);
    const tree = await listTree(git, commit.tree, { maxEntries: 1 });
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toHaveLength(1);
  });

  it('detects renames, rename+edit, adds and deletes with the fixed policy', async () => {
    const [c0, c1, c2, c3] = fixture.commits as [string, string, string, string];
    expect(await diffTrees(git, c0, c1)).toEqual([
      expect.objectContaining({ status: 'R', similarity: 100, oldPath: 'src/a.ts', newPath: 'src/moved.ts' }),
    ]);
    const second = await diffTrees(git, c1, c2);
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'R', oldPath: 'src/moved.ts', newPath: 'lib/final.ts' }),
        expect.objectContaining({ status: 'A', oldPath: null, newPath: 'src/new.ts' }),
      ]),
    );
    expect(second.find((c) => c.status === 'R')!.similarity).toBeGreaterThanOrEqual(80);
    expect(await diffTrees(git, c2, c3)).toEqual([expect.objectContaining({ status: 'D', oldPath: 'README.md', newPath: null })]);
    const root = await diffTrees(git, null, c0);
    expect(root.map((c) => [c.status, c.newPath])).toEqual([
      ['A', 'README.md'],
      ['A', 'src/a.ts'],
    ]);
  });

  it('preserves adversarial tree entries as raw data', async () => {
    const invalidUtf8 = Buffer.concat([Buffer.from('bad-'), Buffer.from([0xff, 0xfe]), Buffer.from('.ts')]);
    const oid = commitRawTree(
      fixture,
      [
        { mode: '100644', path: 'Readme.md', content: 'a' },
        { mode: '100644', path: 'README.md', content: 'b' },
        { mode: '100644', path: 'line\nbreak.ts', content: 'c' },
        { mode: '100644', path: invalidUtf8, content: 'd' },
        { mode: '120000', path: 'link-to-etc', content: '/etc/passwd' },
        { mode: '160000', path: 'vendor/sub', content: fixture.commits[0]! },
        { mode: '100755', path: 'tools/run.sh', content: '#!/bin/sh\n' },
        { mode: '100644', path: 'café.ts', content: 'nfc' },
        { mode: '100644', path: 'café.ts', content: 'nfd' },
      ],
      { date: DATES[3]!, message: 'raw' },
    );
    const commit = await readCommit(git, oid);
    const tree = await listTree(git, commit.tree, { maxEntries: 100 });
    const byKind = (kind: string) => tree.entries.filter((e) => e.kind === kind).map((e) => e.path);
    expect(byKind('symlink')).toEqual(['link-to-etc']);
    expect(byKind('submodule')).toEqual(['vendor/sub']);
    expect(tree.entries.find((e) => e.path === 'tools/run.sh')!.executable).toBe(true);
    const invalid = tree.entries.filter((e) => e.path === null);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]!.rawPath.equals(invalidUtf8)).toBe(true);
    const names = tree.entries.map((e) => e.path);
    expect(names).toEqual(expect.arrayContaining(['Readme.md', 'README.md', 'line\nbreak.ts', 'café.ts', 'café.ts']));
    // Case-distinct and NFC/NFD-distinct entries stay distinct.
    expect(new Set(names).size).toBe(names.length);
  });

  it('reports missing objects explicitly instead of fetching them', async () => {
    const victim = createGitFixture([{ date: DATES[0]!, message: 'x', files: { 'a.ts': 'export const unique = 4242;' } }]);
    try {
      const opened = await openLocalRepository(victim.dir);
      try {
        const head = await resolveLocalCommit(opened.repo, opened.git);
        const tree = await listTree(opened.git, (await readCommit(opened.git, head)).tree, { maxEntries: 10 });
        const blob = tree.entries[0]!;
        rmSync(path.join(victim.dir, '.git', 'objects', blob.oid.slice(0, 2), blob.oid.slice(2)));
        expect(await batchCheck(opened.git, [blob.oid])).toEqual([{ oid: blob.oid, type: 'missing', size: null }]);
        await expect(readObjects(opened.git, [{ oid: blob.oid, size: 30 }])).rejects.toMatchObject({ code: 'LOCAL_OBJECT_MISSING' });
      } finally {
        await opened.git.dispose();
      }
    } finally {
      victim.dispose();
    }
  });
});

describe('execution traps (security gate §16.3)', () => {
  it('never runs hooks, filters, textconv, external diff, helpers, aliases or lazy fetch', async () => {
    const trapped = createGitFixture([
      { date: DATES[0]!, message: 'one', files: { 'a.ts': `${longBody}\n`, 'b.bin': 'x' } },
      { date: DATES[1]!, message: 'two', files: { 'a.ts': `${longBody}\nexport const changed = 1;\n` }, renames: [['b.bin', 'c.bin']] },
    ]);
    const { sentinelDir } = armExecutionTraps(trapped);
    // Make a referenced blob disappear so a lazy fetch through the trap remote would be attempted.
    const opened = await openLocalRepository(trapped.dir);
    try {
      const head = await resolveLocalCommit(opened.repo, opened.git, 'main');
      const commit = await readCommit(opened.git, head);
      const tree = await listTree(opened.git, commit.tree, { maxEntries: 100 });
      await readObjects(opened.git, tree.entries.map((e) => ({ oid: e.oid, size: e.size! })));
      await diffTrees(opened.git, commit.parents[0]!, head);
      await diffTrees(opened.git, null, commit.parents[0]!);
      const missing = 'f'.repeat(40);
      expect(await batchCheck(opened.git, [missing])).toEqual([{ oid: missing, type: 'missing', size: null }]);
      expect(readdirSync(sentinelDir).filter((f) => f.startsWith('sentinel-'))).toEqual([]);
    } finally {
      await opened.git.dispose();
    }

    // Control: ordinary Git honoring the repository configuration does trigger the traps,
    // proving they were armed (otherwise the assertion above would be vacuous).
    try {
      runGit(trapped.dir, ['-c', 'core.hooksPath=.git/hooks', 'diff', 'HEAD~1', 'HEAD'], { timeoutMs: 20_000 });
    } catch {
      // A failing trap command is fine; only the sentinel matters.
    }
    expect(readdirSync(sentinelDir).some((f) => f.startsWith('sentinel-'))).toBe(true);
    trapped.dispose();
  });
});

describe('bounded processes', () => {
  it('kills a child that exceeds its deadline', async () => {
    const started = Date.now();
    await expect(
      runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { PATH: process.env['PATH'] ?? '' }, cwd: process.cwd(), timeoutMs: 300, maxStdoutBytes: 1024 }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('kills grandchildren with the process tree', async () => {
    const marker = path.join(fixture.dir, '..', `atlas-grandchild-${process.pid}-${Date.now()}`);
    const script = `const {spawn}=require('child_process');spawn(process.execPath,['-e','setTimeout(()=>require("fs").writeFileSync(${JSON.stringify(marker)},"alive"),1500)'],{stdio:'ignore'});setTimeout(()=>{},60000)`;
    await expect(
      runBounded(process.execPath, ['-e', script], { env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '' }, cwd: process.cwd(), timeoutMs: 500, maxStdoutBytes: 1024 }),
    ).rejects.toBeInstanceOf(IngestError);
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it('caps output', async () => {
    await expect(
      runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { env: { PATH: process.env['PATH'] ?? '' }, cwd: process.cwd(), timeoutMs: 10_000, maxStdoutBytes: 1000 }),
    ).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
  });

  it('cancels on abort', async () => {
    const controller = new AbortController();
    const run = runBounded(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: { PATH: process.env['PATH'] ?? '' }, cwd: process.cwd(), timeoutMs: 30_000, maxStdoutBytes: 1024, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
