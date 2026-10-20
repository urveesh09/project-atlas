import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyzeCommit } from '@atlas/analyzer-core';
import { gitVersion, openLocalRepository, resolveLocalCommit } from '@atlas/ingest';
import { LIMITS, localRepositoryId } from '@atlas/schema';
import { selectFrameIndices } from '@atlas/history';
import { createGitFixture } from '@atlas/test-fixtures';

type Commit = { date: string; files: Record<string, string | null>; renames?: [string, string][] };
const { buildExactCapacityCommits, frameCommitIndices } = await import(pathToFileURL(path.resolve('scripts/lib/exact-capacity.mjs')).href);

/** The tree after each commit, replayed exactly as createGitFixture writes it. */
function replay(commits: Commit[]): Map<string, string>[] {
  const tree = new Map<string, string>();
  return commits.map((commit) => {
    for (const [from, to] of commit.renames ?? []) {
      expect(tree.has(from) && !tree.has(to)).toBe(true);
      tree.set(to, tree.get(from)!);
      tree.delete(from);
    }
    for (const [file, text] of Object.entries(commit.files)) {
      if (text === null) expect(tree.delete(file)).toBe(true);
      else tree.set(file, text);
    }
    return new Map(tree);
  });
}
const importLines = (text: string) => text.split('\n').filter((line) => line.startsWith('import '));

describe('exact capacity fixture (ADR-082)', () => {
  it('selects the frames the history package selects', () => {
    expect(frameCommitIndices()).toEqual(selectFrameIndices(40, LIMITS.analyzedFrames));
  });

  it('holds exactly the plan ceilings in every frame and across frames', () => {
    const { commits, expected } = buildExactCapacityCommits();
    expect(commits).toHaveLength(40);
    const trees = replay(commits);
    const frames = frameCommitIndices().map((i: number) => trees[i]!);
    const lineages = new Set<string>();
    for (const tree of frames) {
      expect(tree.size).toBe(LIMITS.includedFilesPerSnapshot);
      // Every import names a distinct target, so statements are dependency edges.
      expect([...tree.values()].reduce((sum, text) => sum + importLines(text).length, 0)).toBe(LIMITS.sourceDependencyEdgesPerSnapshot);
      for (const text of tree.values()) expect(new Set(importLines(text).map((l) => l.split(' from ')[1])).size).toBe(importLines(text).length);
      // Every import target exists in the frame.
      for (const [file, text] of tree) for (const line of importLines(text)) {
        const target = line.split(' from ')[1]!.slice(1, -2);
        if (target.startsWith('../')) expect(tree.has(path.posix.join(path.posix.dirname(file), `${target}.ts`))).toBe(true);
        else if (target.startsWith('@bench/')) expect(tree.has(target.replace(/^@bench\/(p\d+)\//, 'packages/$1/src/') + '.ts')).toBe(true);
      }
    }
    // Lineages: a path's lineage continues through its renames; deleted paths never return.
    const lineageOf = new Map<string, number>();
    let next = 0;
    const seen = new Set<string>();
    commits.forEach((commit: Commit, c: number) => {
      for (const [from, to] of commit.renames ?? []) { lineageOf.set(to, lineageOf.get(from)!); lineageOf.delete(from); }
      for (const [file, text] of Object.entries(commit.files)) {
        if (text === null) lineageOf.delete(file);
        else if (!lineageOf.has(file)) {
          expect(seen.has(file)).toBe(false);
          seen.add(file);
          lineageOf.set(file, next++);
        }
      }
      if (frameCommitIndices().includes(c)) for (const id of lineageOf.values()) lineages.add(String(id));
    });
    expect(lineages.size).toBe(LIMITS.historicalUnionLineages);
    expect(expected).toMatchObject({ files: 10_000, edgesPerFrame: 100_000, union: 20_000, frames: 12 });
    // Nothing imports a renamed or retired module, so no edge is lost to churn.
    const imported = new Set([...frames.at(-1)!.values()].flatMap((t) => importLines(t).map((l) => l.split(' from ')[1]!)));
    for (const commit of commits as Commit[]) for (const [from] of commit.renames ?? []) expect([...imported].some((s) => s.includes(`/${path.posix.basename(from, '.ts')}'`))).toBe(false);
  });

  it('is deterministic', () => {
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    expect(digest(buildExactCapacityCommits({ shape: 'dense' }))).toBe(digest(buildExactCapacityCommits({ shape: 'dense' })));
    expect(digest(buildExactCapacityCommits({ files: 600, edges: 3000, union: 1200, stable: 300 }))).toBe(digest(buildExactCapacityCommits({ files: 600, edges: 3000, union: 1200, stable: 300 })));
  });

  it('matches the analyzer exactly at a reduced scale', async () => {
    const options = { files: 600, edges: 3000, union: 1200, stable: 300 };
    const { commits, expected } = buildExactCapacityCommits(options);
    const fixture = createGitFixture(commits);
    const { repo, git } = await openLocalRepository(fixture.dir);
    try {
      const result = await analyzeCommit({
        git, commitOid: await resolveLocalCommit(repo, git), gitVersion: await gitVersion(),
        repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'exact', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
      });
      expect(result.status).toBe('complete');
      expect(result.draft.graphs).toHaveLength(12);
      for (const graph of result.draft.graphs) {
        expect(graph.nodes.filter((n) => n.kind === 'file')).toHaveLength(options.files);
        expect(graph.edges).toHaveLength(options.edges);
        expect(graph.coverage.limitsHit).toEqual([]);
      }
      expect(result.summary.history).toMatchObject({ status: 'complete', lineages: options.union, renames: expected.renames });
    } finally {
      await git.dispose();
      fixture.dispose();
    }
  }, 120_000);

  it('builds a dense fixture whose every module imports the hubs', () => {
    const { commits, expected } = buildExactCapacityCommits({ shape: 'dense', imports: 13 });
    const tree = replay(commits)[0]!;
    expect(tree.size).toBe(10_000);
    const statements = [...tree.values()].reduce((sum, text) => sum + importLines(text).length, 0);
    expect(statements).toBe(expected.edgeCandidates);
    expect(statements).toBeGreaterThan(LIMITS.sourceDependencyEdgesPerSnapshot);
    // Hub s0 lives at packages/p0/src/m0/s0.ts; no other module path ends in m0/s0.
    const hubImporters = [...tree.entries()].filter(([file, text]) => file !== 'packages/p0/src/m0/s0.ts' && /m0\/s0'/.test(text));
    expect(hubImporters).toHaveLength(expected.hubFanIn);
  });
});
