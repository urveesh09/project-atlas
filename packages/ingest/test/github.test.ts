import { afterAll, describe, expect, it } from 'vitest';
import {
  SafeGit,
  acquireGithubCommit,
  batchCheck,
  fetchBlobs,
  listTree,
  parseGithubRepositoryUrl,
  readCommit,
  resolveGithubRepository,
  type FetchLike,
} from '@atlas/ingest';

describe('GitHub URL admission (plan §8.2)', () => {
  it.each([
    ['https://github.com/octocat/Hello-World', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World/', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/octocat/Hello-World.git', { owner: 'octocat', name: 'Hello-World' }],
    ['https://github.com/a-b/c.d_e', { owner: 'a-b', name: 'c.d_e' }],
  ])('accepts %s', (url, expected) => {
    expect(parseGithubRepositoryUrl(url)).toEqual(expected);
  });

  it.each([
    'http://github.com/o/r',
    'https://github.com/o',
    'https://github.com/o/r/tree/main',
    'https://github.com/o/r?tab=readme',
    'https://github.com/o/r#readme',
    'https://user:pass@github.com/o/r',
    'https://github.com:443/o/r',
    'https://github.com:8443/o/r',
    'https://GitHub.com/o/r',
    'https://github.com.evil.com/o/r',
    'https://evil.com/github.com/o/r',
    'https://gist.github.com/o/r',
    'https://140.82.112.3/o/r',
    'git@github.com:o/r.git',
    'ssh://git@github.com/o/r',
    'file:///etc/passwd',
    'https://github.com/o/r\\..',
    'https://github.com/o%2Fr/x',
    'https://github.com/o/%2e%2e',
    'https://github.com/./r',
    'https://github.com/o/..',
    'https://github.com/o/r/../../x',
    'https://github.com/-o/r',
    'https://github.com/o--/r',
    'https://github.com/o/r\n',
    ' https://github.com/o/r',
    'https://github.com/o/r.git.git',
    'https://github.com/o/r//',
    'javascript:alert(1)',
    '',
  ])('rejects %j', (url) => {
    expect(() => parseGithubRepositoryUrl(url)).toThrow(expect.objectContaining({ code: 'INVALID_REPOSITORY_URL' }));
  });
});

function fakeFetch(routes: Record<string, { status: number; body?: unknown; headers?: Record<string, string> }>): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string, init: { redirect: string }) => {
    calls.push(url);
    expect(init.redirect).toBe('manual');
    const route = routes[url] ?? { status: 404 };
    return {
      status: route.status,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      json: async () => route.body,
    };
  }) as unknown as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const repoUrl = 'https://api.github.com/repos/octo/demo';
const refUrl = 'https://api.github.com/repos/octo/demo/git/ref/heads/main';
const publicRepo = { id: 42, full_name: 'octo/demo', private: false, visibility: 'public', default_branch: 'main', size: 10 };

describe('GitHub metadata resolution', () => {
  it('resolves identity and an immutable commit, constructing URLs from validated parts', async () => {
    const fetch = fakeFetch({ [repoUrl]: { status: 200, body: publicRepo }, [refUrl]: { status: 200, body: { object: { type: 'commit', sha: 'a'.repeat(40) } } } });
    const info = await resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch });
    expect(info).toMatchObject({ numericId: '42', defaultBranch: 'main', headOid: 'a'.repeat(40), visibility: 'public' });
    expect(fetch.calls).toEqual([repoUrl, refUrl]);
  });

  it('treats private repositories exactly like missing ones', async () => {
    const fetch = fakeFetch({ [repoUrl]: { status: 200, body: { ...publicRepo, private: true, visibility: 'private' } } });
    await expect(resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch })).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
  });

  it('does not follow redirects for transferred repositories', async () => {
    const fetch = fakeFetch({ [repoUrl]: { status: 301, headers: { location: 'https://api.github.com/repositories/42' } } });
    await expect(resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch })).rejects.toMatchObject({ code: 'REPOSITORY_MOVED' });
    expect(fetch.calls).toEqual([repoUrl]);
  });

  it('detects renamed repositories served under the old name', async () => {
    const fetch = fakeFetch({ [repoUrl]: { status: 200, body: { ...publicRepo, full_name: 'other/demo' } } });
    await expect(resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch })).rejects.toMatchObject({ code: 'REPOSITORY_MOVED' });
  });

  it('maps rate limits, outages and empty repositories', async () => {
    await expect(
      resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch: fakeFetch({ [repoUrl]: { status: 403, headers: { 'x-ratelimit-remaining': '0' } } }) }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
    await expect(resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch: fakeFetch({ [repoUrl]: { status: 503 } }) })).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    });
    await expect(
      resolveGithubRepository({ owner: 'octo', name: 'demo' }, { fetch: fakeFetch({ [repoUrl]: { status: 200, body: publicRepo }, [refUrl]: { status: 409 } }) }),
    ).rejects.toMatchObject({ code: 'EMPTY_REPOSITORY' });
  });
});

/**
 * Live acquisition spike (P0.3). Opt-in because it depends on github.com:
 *   ATLAS_NETWORK_TESTS=1 pnpm vitest run packages/ingest/test/github.test.ts
 */
describe.runIf(process.env['ATLAS_NETWORK_TESTS'] === '1')('live filtered acquisition', () => {
  const disposers: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const dispose of disposers) await dispose();
  });

  it('fetches one commit shallowly without blobs, then blobs only by explicit request', async () => {
    const ref = parseGithubRepositoryUrl('https://github.com/octocat/Hello-World');
    const info = await resolveGithubRepository(ref);
    const options = { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 };
    const acquired = await acquireGithubCommit(ref, info.headOid, options);
    disposers.push(() => acquired.git.dispose());

    // Offline reader over the acquired objects: blobs are absent and are NOT lazily fetched.
    const offline = await SafeGit.create({ objectDirectory: acquired.objectsDir, objectFormat: 'sha1', network: { kind: 'offline' } });
    disposers.push(() => offline.dispose());
    const commit = await readCommit(offline, info.headOid);
    const tree = await listTree(offline, commit.tree, { maxEntries: 1000 });
    const blobs = tree.entries.filter((e) => e.kind === 'blob');
    expect(blobs.length).toBeGreaterThan(0);
    const before = await batchCheck(offline, blobs.map((b) => b.oid));
    expect(before.every((b) => b.type === 'missing')).toBe(true);

    await fetchBlobs(acquired, blobs.map((b) => b.oid), options);
    const after = await batchCheck(offline, blobs.map((b) => b.oid));
    expect(after.every((b) => b.type === 'blob')).toBe(true);
    console.info(`[P0.3 evidence] acquired ${info.owner}/${info.name}@${info.headOid.slice(0, 12)}: ${acquired.bytesOnDisk} bytes before blobs, ${blobs.length} blob(s) fetched on request`);
  });

  it('kills acquisition that exceeds the byte budget', async () => {
    const ref = parseGithubRepositoryUrl('https://github.com/microsoft/TypeScript');
    const info = await resolveGithubRepository(ref);
    await expect(acquireGithubCommit(ref, info.headOid, { maxBytes: 256 * 1024, timeoutMs: 120_000, depth: 50 })).rejects.toMatchObject({
      code: 'REPOSITORY_TOO_LARGE',
    });
  });
});
