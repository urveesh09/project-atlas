import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SafeGit, acquireGithubCommit, listTree, readCommit } from '@atlas/ingest';
import { buildDemoRepository, runGit } from '@atlas/test-fixtures';

/**
 * A blob absent from the object store (a partial acquisition, a damaged store) must be an
 * explicit LOCAL_OBJECT_MISSING failure. Git reports its size as "BAD" or "-"; reading
 * that as an unknown or zero size would publish a fabricated empty file (plan §4.3).
 */
describe('missing blobs fail explicitly and are never fetched lazily', () => {
  const demo = buildDemoRepository();
  const scratch = mkdtempSync(path.join(tmpdir(), 'atlas-partial-'));
  afterAll(() => {
    demo.dispose();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('acquires commits and trees only, then refuses to list a tree whose blobs are absent', async () => {
    runGit(demo.dir, ['config', 'uploadpack.allowFilter', 'true']);
    const head = demo.commits.at(-1)!;
    const acquired = await acquireGithubCommit({ owner: 'atlas-demo', name: 'harbor' }, head, {
      depth: 1, maxBytes: 64 * 1024 * 1024, timeoutMs: 60_000, filter: 'blob:none', fixtureRemote: demo.dir, scratchDir: path.join(scratch, 'git'),
    });
    const offline = await SafeGit.create({ objectDirectory: acquired.objectsDir, objectFormat: 'sha1', network: { kind: 'offline' } });
    try {
      const commit = await readCommit(offline, head);
      await expect(listTree(offline, commit.tree, { maxEntries: 1000 })).rejects.toMatchObject({ code: 'LOCAL_OBJECT_MISSING' });
    } finally {
      await offline.dispose();
      await acquired.git.dispose();
    }
  });
});
