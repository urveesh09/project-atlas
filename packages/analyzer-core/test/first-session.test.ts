import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SnapshotFS, SnapshotResolver, extractFileFacts, isSupportedSourcePath } from '@atlas/analyzer-ts';
import { decodeStrictUtf8, diffTrees, listTree, openLocalRepository, readCommit, readObjects, resolveLocalCommit, type SafeGit } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';
import {
  DEMO_HEAD_FILES,
  DEMO_HEAD_IMPORTS,
  DEMO_RENAME,
  armExecutionTraps,
  buildDemoRepository,
  type ExpectedImport,
  type GitFixture,
} from '@atlas/test-fixtures';

/**
 * Plan §17 "first implementation session": a real Git repository containing TS/JS, an
 * alias, a workspace import, a type import, a hook sentinel and a rename. Committed
 * blobs are read through the sanitized Git reader, then parsed and resolved over the
 * virtual snapshot, and compared with independently authored expectations.
 */
let demo: GitFixture;
let git: SafeGit;
let sentinelDir: string;
let head: string;
let snapshot: SnapshotFS;

beforeAll(async () => {
  demo = buildDemoRepository();
  ({ sentinelDir } = armExecutionTraps(demo));
  const opened = await openLocalRepository(demo.dir);
  git = opened.git;
  head = await resolveLocalCommit(opened.repo, git);
  const commit = await readCommit(git, head);
  const tree = await listTree(git, commit.tree, { maxEntries: LIMITS.treeEntriesPerSnapshot });
  const blobs = tree.entries.filter((e) => e.kind === 'blob' && e.size !== null && e.size <= LIMITS.sourceBlobBytes);
  const contents = await readObjects(git, blobs.map((b) => ({ oid: b.oid, size: b.size! })));
  snapshot = new SnapshotFS(
    tree.entries
      .filter((e) => e.path !== null)
      .map((e) => {
        const bytes = contents.get(e.oid)?.bytes;
        const text = bytes && !bytes.includes(0) ? decodeStrictUtf8(bytes) : null;
        return { path: e.path!, text };
      }),
  );
});

afterAll(async () => {
  await git?.dispose();
  demo?.dispose();
});

describe('Harbor demo through the safe reader', () => {
  it('has a reproducible history', () => {
    const again = buildDemoRepository();
    try {
      expect(again.commits).toEqual(demo.commits);
      expect(demo.commits).toHaveLength(12);
    } finally {
      again.dispose();
    }
  });

  it('enumerates exactly the committed HEAD tree', () => {
    expect(snapshot.paths()).toEqual([...DEMO_HEAD_FILES]);
    expect(snapshot.readText('assets/harbor.png')).toBeNull();
  });

  it('resolves every import to its independently expected outcome', () => {
    const resolver = new SnapshotResolver(snapshot);
    const actual: Record<string, ExpectedImport[]> = {};
    for (const path of snapshot.paths()) {
      if (!isSupportedSourcePath(path)) continue;
      const facts = extractFileFacts(path, snapshot.readText(path)!);
      expect(facts.parseStatus, path).toBe('parsed');
      actual[path] = facts.imports.map((imp) => {
        const r = resolver.resolve(path, imp);
        return [r.kind, imp.specifier!, r.status, r.targetPath ?? r.externalName, r.confidence, r.reasonCode] as const;
      });
    }
    expect(actual).toEqual(DEMO_HEAD_IMPORTS);
  });

  it('detects the authored rename between consecutive commits', async () => {
    const after = demo.commits[DEMO_RENAME.commitIndex]!;
    const before = demo.commits[DEMO_RENAME.commitIndex - 1]!;
    const changes = await diffTrees(git, before, after);
    expect(changes).toContainEqual(
      expect.objectContaining({ status: 'R', oldPath: DEMO_RENAME.from, newPath: DEMO_RENAME.to, similarity: DEMO_RENAME.similarity }),
    );
  });

  it('never triggered any repository-configured execution', () => {
    expect(readdirSync(sentinelDir).filter((f) => f.startsWith('sentinel-'))).toEqual([]);
  });

  it('read HEAD as the final authored commit', () => {
    expect(head).toBe(demo.commits.at(-1));
  });
});
