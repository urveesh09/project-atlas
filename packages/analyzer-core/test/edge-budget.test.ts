import { expect, it } from 'vitest';
import { analyzeCommit } from '@atlas/analyzer-core';
import { gzipDeterministic } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit } from '@atlas/ingest';
import { GraphSnapshotSchema, LIMITS, localRepositoryId, type GraphEdge } from '@atlas/schema';
import { createGitFixture } from '@atlas/test-fixtures';
import { boundSnapshotEdges } from '../src/edge-budget.js';

function edge(number: number, kind: GraphEdge['kind'], observationCount: number): GraphEdge {
  return {
    id: `edge_${number.toString(16).padStart(64, '0')}`, sourceId: `node_${'a'.repeat(64)}`, targetId: `node_${'b'.repeat(64)}`,
    kind, confidence: 'exact', observationCount, evidenceIds: [], evidenceOmitted: kind === 'declares-package' ? 0 : observationCount,
  };
}

it('shares the real wire ceiling between source and package edges, with exact multiplicities', () => {
  const source = Array.from({ length: 100_000 }, (_, i) => edge(i + 1, 'imports-value', 2));
  const declared = edge(0, 'declares-package', 7);
  const result = boundSnapshotEdges([declared], { edges: source, edgesOmitted: 2, edgeObservationsOmitted: 5 });
  expect(result.edges).toHaveLength(100_000);
  expect(result.edges[0]).toBe(declared);
  expect(result.edges.at(-1)?.id).toBe(edge(99_999, 'imports-value', 2).id);
  expect(result.edgesOmitted).toBe(3);
  expect(result.relationshipsOmitted).toBe(7); // two newly dropped statements + five already omitted
  expect(GraphSnapshotSchema.shape.edges.safeParse(result.edges).success).toBe(true);
  expect(source).toHaveLength(100_000); // input ownership remains with aggregation
  expect(source.at(-1)?.id).toBe(edge(100_000, 'imports-value', 2).id);
});

it('keeps every relationship below the ceiling in canonical order without mutating its inputs', () => {
  const packageEdges = [edge(3, 'declares-package', 4)];
  const source = [edge(2, 'imports-value', 1), edge(1, 'imports-type', 2)];
  const result = boundSnapshotEdges(packageEdges, { edges: source, edgesOmitted: 0, edgeObservationsOmitted: 0 });
  expect(result.edges.map((e) => e.id)).toEqual([source[1]!.id, source[0]!.id, packageEdges[0]!.id]);
  expect(result).toMatchObject({ edgesOmitted: 0, relationshipsOmitted: 0 });
  expect(source.map((e) => e.id)).toEqual([edge(2, 'imports-value', 1).id, edge(1, 'imports-type', 2).id]);
});

it('publishes explicit partial coverage when package relationships exceed the shared graph edge budget', async () => {
  // 100 manifests × 1,001 distinct declared dependencies = 100,100 relationships.
  // No source imports, duplicate edges, executable configuration or parser timing.
  // This exercises the actual schema boundary through inventory, hierarchy and export.
  const dependencies = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`external-${i}`, '1']));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'budget', private: true, workspaces: ['packages/*'] }),
    'index.ts': 'export const value = 1;\n',
  };
  for (let i = 0; i < 100; i++) files[`packages/p${i}/package.json`] = JSON.stringify({ name: `budget-p${i}`, dependencies });
  const fixture = createGitFixture([{ files, date: '2026-08-01T00:00:00Z', message: 'authored edge budget' }]);
  const { repo, git } = await openLocalRepository(fixture.dir);
  try {
    const result = await analyzeCommit({
      git, commitOid: await resolveLocalCommit(repo, git), gitVersion: await gitVersion(),
      repository: { repoId: localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f'), displayName: 'budget', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
      options: { history: { enabled: false } }, transport: gzipDeterministic,
      now: () => new Date('2026-10-10T00:00:00Z'),
    });
    const graph = result.draft.graphs[0]!;
    expect(result.status).toBe('partial');
    expect(result.packed?.manifest.frames).toHaveLength(1);
    expect(graph.edges).toHaveLength(LIMITS.sourceDependencyEdgesPerSnapshot);
    expect(graph.edges.every((edge) => edge.kind === 'declares-package')).toBe(true);
    expect(graph.coverage.observedImports).toBe(0);
    expect(graph.coverage.limitsHit).toContain('EDGE_LIMIT');
    expect(graph.coverage.reasons).toContainEqual({ code: 'EDGE_LIMIT', count: 100 });
    expect(graph.coverage.reasons).toContainEqual({ code: 'EDGE_RELATIONSHIPS_OMITTED', count: 100 });
    expect(graph.diagnostics.find((d) => d.ruleId === 'ATLAS_ANALYSIS_LIMIT')?.parameters).toMatchObject({ limit: 'EDGE_LIMIT', count: 100 });
    const file = graph.nodes.find((node) => node.kind === 'file' && node.path === 'index.ts')!;
    expect(graph.metrics.find((metric) => metric.nodeId === file.id)?.availability).toMatchObject({ syntax: 'complete', dependencies: 'partial' });
  } finally { await git.dispose(); fixture.dispose(); }
}, 120_000);
