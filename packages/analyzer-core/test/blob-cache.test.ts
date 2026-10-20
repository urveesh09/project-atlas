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

it('releases bytes two frames old, reads them again when needed and never counts them twice (ADR-084)', async () => {
  const source = 'export const a = 1;\n';
  const fixture = createGitFixture([{ date: '2026-10-01T00:00:00Z', message: 'release', files: { 'a.ts': source, 'b.ts': source.replace('a =', 'b =') } }]);
  const { git } = await openLocalRepository(fixture.dir);
  try {
    const commit = await readCommit(git, fixture.commits[0]!);
    const entries = (await listTree(git, commit.tree, { maxEntries: 10 })).entries;
    const object = (name: string) => ({ oid: entries.find((e) => e.path === name)!.oid, size: Buffer.byteLength(source) });
    const reads: string[][] = [];
    const counted = new Proxy(git, {
      get: (target, key, receiver) => {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function') return value;
        if (key !== 'run') return value.bind(target);
        return (args: string[], options: unknown) => {
          if (args.includes('--batch')) reads.push(args);
          return value.call(target, args, options);
        };
      },
    });
    // Exactly the two blobs fit the budget: a re-read of a released blob must not count again.
    const cache = new BlobCache(Buffer.byteLength(source) * 2);
    cache.enforce = true;
    await cache.read(counted, [object('a.ts')]);
    cache.advance();
    await cache.read(counted, [object('b.ts')]);
    cache.advance();
    const readsBefore = reads.length;
    // b.ts was read by the last frame and is still held; a.ts is two frames old and released.
    expect((await cache.read(counted, [object('b.ts')])).get(object('b.ts').oid)!.bytes.toString('utf8')).toBe(source.replace('a =', 'b ='));
    expect(reads.length).toBe(readsBefore);
    expect((await cache.read(counted, [object('a.ts')])).get(object('a.ts').oid)!.bytes.toString('utf8')).toBe(source);
    expect(reads.length).toBe(readsBefore + 1);
    expect(cache.distinctBytes).toBe(Buffer.byteLength(source) * 2);
  } finally { await git.dispose(); fixture.dispose(); }
});
