import { expect, it } from 'vitest';
import { openLocalRepository, readCommit, listTree } from '@atlas/ingest';
import { createGitFixture } from '@atlas/test-fixtures';
import { BlobCache } from '../src/blob-cache.js';

it('counts distinct bytes once, rejects historical expansion before reading and preserves the selected-commit cache', async () => {
  const source = 'export const a = 1;\n';
  const fixture = createGitFixture([{ date: '2026-10-01T00:00:00Z', message: 'budget', files: {
    'a.ts': source, 'copy.ts': source, 'b.ts': source.replace('a =', 'b ='), 'c.ts': source.replace('a =', 'c ='),
  } }]);
  const { git } = await openLocalRepository(fixture.dir);
  try {
    const commit = await readCommit(git, fixture.commits[0]!);
    const entries = (await listTree(git, commit.tree, { maxEntries: 10 })).entries;
    const object = (name: string) => {
      const entry = entries.find((e) => e.path === name)!;
      return { oid: entry.oid, size: Buffer.byteLength(source) };
    };
    const cache = new BlobCache(Buffer.byteLength(source) * 2);
    await cache.read(git, [object('a.ts'), object('copy.ts')]);
    expect(cache.distinctBytes).toBe(Buffer.byteLength(source));
    cache.enforce = true;
    await cache.read(git, [object('a.ts'), object('b.ts')]);
    expect(cache.distinctBytes).toBe(Buffer.byteLength(source) * 2);
    await expect(cache.read(git, [object('c.ts')])).rejects.toMatchObject({ details: { limit: 'HISTORY_SOURCE_BUDGET' } });
    expect(cache.distinctBytes).toBe(Buffer.byteLength(source) * 2);
    expect((await cache.read(git, [object('a.ts')])).get(object('a.ts').oid)!.bytes.toString('utf8')).toBe(source);
  } finally { await git.dispose(); fixture.dispose(); }
});
