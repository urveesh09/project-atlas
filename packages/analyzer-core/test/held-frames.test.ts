import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { analyzeCommit, type AnalysisResult } from '@atlas/analyzer-core';
import { packArtifact } from '@atlas/artifact';
import { gzipDeterministic } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit, type SafeGit } from '@atlas/ingest';
import { canonicalJson, localRepositoryId } from '@atlas/schema';
import { buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';

// ADR-084: a kept historical frame that no later frame is encoded against is held as its
// encoded delta and restored for assembly. Restores are the only inflate calls.
const inflates = vi.hoisted(() => ({ count: 0 }));
vi.mock('node:zlib', async (original) => {
  const zlib = await original<typeof import('node:zlib')>();
  return {
    ...zlib,
    inflateRawSync: (...args: Parameters<typeof zlib.inflateRawSync>) => {
      inflates.count++;
      return zlib.inflateRawSync(...args);
    },
  };
});

const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
let demo: GitFixture;
let git: SafeGit;
let head: string;
let version: string;

const run = (packed: boolean): Promise<AnalysisResult> =>
  analyzeCommit({
    git,
    commitOid: head,
    gitVersion: version,
    repository: { repoId, displayName: 'harbor', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
    now: () => new Date('2026-10-10T00:00:00.000Z'),
    ...(packed ? { transport: gzipDeterministic } : {}),
  });

beforeAll(async () => {
  demo = buildDemoRepository();
  const opened = await openLocalRepository(demo.dir);
  git = opened.git;
  head = await resolveLocalCommit(opened.repo, git);
  version = await gitVersion();
}, 120_000);
afterAll(async () => {
  await git?.dispose();
  demo?.dispose();
});

describe('held historical frames (ADR-084)', () => {
  it('restores every held frame exactly, and packs the chunks a fresh encoding would', async () => {
    inflates.count = 0;
    const packed = await run(true);
    const frames = packed.draft.graphs.length;
    expect(frames).toBeGreaterThan(3);
    // Every kept frame but the selected one and the oldest was held, then restored.
    expect(inflates.count).toBe(frames - 2);

    const plain = await run(false);
    expect(inflates.count).toBe(frames - 2);
    expect(plain.draft.graphs.map((g) => canonicalJson(g))).toEqual(packed.draft.graphs.map((g) => canonicalJson(g)));
    expect(canonicalJson(plain.draft.history)).toBe(canonicalJson(packed.draft.history));
    expect(canonicalJson(plain.draft.layout)).toBe(canonicalJson(packed.draft.layout));
    expect(packArtifact(plain.draft, gzipDeterministic).manifest.chunks).toEqual(packed.packed!.manifest.chunks);
  }, 180_000);
});
