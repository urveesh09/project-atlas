import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeCommit, type AnalysisResult } from '@atlas/analyzer-core';
import { gzipDeterministic, packArtifact } from '@atlas/artifact/node';
import { gitVersion, openLocalRepository, resolveLocalCommit, type SafeGit } from '@atlas/ingest';
import { localRepositoryId, sha256Hex, validateArtifactBundle } from '@atlas/schema';
import { DEMO_HEAD_FILES, DEMO_HEAD_IMPORTS, buildDemoRepository, type GitFixture } from '@atlas/test-fixtures';

const repoId = localRepositoryId('3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f');
let demo: GitFixture;
let git: SafeGit;
let head: string;
let version: string;

const run = (options: Parameters<typeof analyzeCommit>[0]['options'] = {}): Promise<AnalysisResult> =>
  analyzeCommit({
    git,
    commitOid: head,
    gitVersion: version,
    repository: { repoId, displayName: 'harbor', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
    options,
    now: () => new Date('2026-10-10T00:00:00.000Z'),
  });

beforeAll(async () => {
  demo = buildDemoRepository();
  const opened = await openLocalRepository(demo.dir);
  git = opened.git;
  head = await resolveLocalCommit(opened.repo, git);
  version = await gitVersion();
});
afterAll(async () => {
  await git?.dispose();
  demo?.dispose();
});

describe('Harbor structural artifact (M1)', () => {
  it('produces a bundle that passes every invariant', async () => {
    const result = await run();
    const packed = packArtifact(result.draft, gzipDeterministic);
    expect(validateArtifactBundle({ manifest: packed.manifest, graphs: result.draft.graphs, history: result.draft.history, layout: result.draft.layout }).ok).toBe(true);
    expect(result.status).toBe('complete');
    expect(result.draft.graphs).toHaveLength(12);
    const graph = result.draft.graphs.at(-1)!;
    expect(graph.nodes.filter((n) => n.kind === 'file').map((n) => (n.kind === 'file' ? n.path : '')).sort()).toEqual([...DEMO_HEAD_FILES].sort());
    // Import counts follow from the hand-written DEMO_HEAD_IMPORTS table: 25 statements,
    // 21 internal, 3 declared externals (decimal.js, react, vitest), 1 built-in (node:path).
    expect(graph.coverage).toMatchObject({
      discoveredFiles: 26,
      includedFiles: 26,
      supportedFiles: 14,
      opaqueFiles: 12,
      excludedFiles: 0,
      omittedFiles: 0,
      parsedFiles: 14,
      parseFailedFiles: 0,
      observedImports: 25,
      internalResolved: 21,
      externalResolved: 3,
      builtinResolved: 1,
      unresolved: 0,
      unsupported: 0,
      excludedTargets: 0,
    });
  });

  it('records every import exactly as the independent Harbor expectations say', async () => {
    const graph = (await run()).draft.graphs.at(-1)!;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const actual: Record<string, string[][]> = {};
    for (const obs of graph.importObservations) {
      const source = byId.get(obs.sourceId)!;
      const target = obs.targetId ? byId.get(obs.targetId)! : null;
      const targetKey = target === null ? null : target.kind === 'file' ? target.path : target.kind === 'external-package' ? target.packageName : target.kind === 'builtin' ? target.moduleName : null;
      const path = source.kind === 'file' ? source.path : '';
      (actual[path] ??= []).push([obs.kind, obs.specifier!, obs.status, targetKey!, obs.confidence!, obs.reasonCode!].map(String));
    }
    for (const [path, expected] of Object.entries(DEMO_HEAD_IMPORTS)) {
      const sortRows = (rows: string[][]) => [...rows].sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
      expect(sortRows(actual[path] ?? []), path).toEqual(sortRows(expected.map((row) => row.map(String))));
    }
  });

  it('finds the authored router/handlers cycle and nothing spurious', async () => {
    const graph = (await run()).draft.graphs.at(-1)!;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const findings = graph.diagnostics.map((d) => [d.ruleId, ...d.subjectIds.map((id) => (byId.get(id) as { path?: string }).path ?? '').sort()]);
    expect(findings).toEqual([['ATLAS_STATIC_CYCLE', 'src/server/handlers.ts', 'src/server/router.ts']]);
    const pricing = graph.metrics.find((m) => (byId.get(m.nodeId) as { path?: string }).path === 'src/server/pricing.ts')!;
    // quote(), counted from the pricing(4) source in demo.ts:
    //   1 base + if(weight<=0) + if(hazardous) + if(refrigerated) + && + for-of + ?? (legs ?? [])
    //   + if + || + && + else-if + ?: (discount) + ?? (discount ?? 0) + case 'peak' + case 'storm'
    //   + ?: (priority) + while + && + catch = 19
    // base(): 1 + ?: + ?: = 3, so sum = 22 over 2 callables.
    // Fan-in (value/dynamic): handlers.ts, main.tsx (dynamic import), tests/pricing.test.ts = 3.
    // Fan-out: @harbor/ledger (value) = 1; './handlers' is type-only and excluded.
    expect(pricing).toMatchObject({ maxCyclomatic: 19, sumCyclomatic: 22, callableCount: 2, fanIn: 3, fanOut: 1 });
  });

  it('builds the expected package hierarchy', async () => {
    const graph = (await run()).draft.graphs.at(-1)!;
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const containers = graph.nodes
      .flatMap((n) => (n.kind === 'package' || n.kind === 'directory' ? [`${n.kind}:${n.path} <- ${byId.get(n.parentId!)!.kind}:${'path' in byId.get(n.parentId!)! ? (byId.get(n.parentId!) as { path: string }).path : ''}`] : []))
      .sort();
    expect(containers).toEqual([
      'directory:assets <- package:',
      'directory:packages/geo/src <- package:packages/geo',
      'directory:packages/ledger/src <- package:packages/ledger',
      'directory:src <- package:',
      'directory:src/server <- directory:src',
      'directory:src/ui <- directory:src',
      'directory:tests <- package:',
      'package: <- repository:',
      'package:packages/geo <- repository:',
      'package:packages/ledger <- repository:',
    ]);
    const externals = graph.nodes.flatMap((n) => (n.kind === 'external-package' ? [n.packageName] : [])).sort();
    expect(externals).toEqual(['decimal.js', 'react', 'typescript', 'vitest', 'zod']);
  });

  it('is reproducible: identical chunk hashes across runs, only envelope fields differ', async () => {
    const a = packArtifact((await run()).draft, gzipDeterministic);
    const b = packArtifact((await run()).draft, gzipDeterministic);
    expect(a.manifest.chunks).toEqual(b.manifest.chunks);
    expect(a.manifest.analysisKey).toBe(b.manifest.analysisKey);
    expect(a.manifest.analysisId).not.toBe(b.manifest.analysisId);
  });

  it('matches the cross-platform golden (asserted on Windows and Linux CI)', async () => {
    const packed = packArtifact((await run()).draft, gzipDeterministic);
    // The Harbor commits, fixture identity and repoId are fixed, so these canonical
    // hashes must be identical on every platform. A change here is a contract change.
    const frames = packed.manifest.frames.map((f) => f.graphChunk.sha256);
    expect({
      head: frames.at(-1),
      allFrames: sha256Hex(frames.join(',')),
      history: packed.manifest.historyChunk.sha256,
      layout: packed.manifest.layoutChunk.sha256,
    }).toMatchInlineSnapshot(`
      {
        "allFrames": "2807b87493dd6dba0e1ed0db222d34eab96da531a5bbddd04e6cd8ab7a43682d",
        "head": "b692048222d869a2c280b3af905845c852b9ee1b0bf0d2b1cf269e5d560e285d",
        "history": "c1299683c5b1aaa5991862eda00d9d19947da8aa9d489a0efcfb5e0501d917f3",
        "layout": "363cbc5fbd71f14c99e86186a9a7b26c8a444f7bc772d7048dea3f9424cd1612",
      }
    `);
  });

  it('reports partial results with exact omissions when a limit is lowered', async () => {
    const result = await run({ limits: { includedFiles: 10 } });
    expect(result.status).toBe('partial');
    const coverage = result.draft.graphs.at(-1)!.coverage;
    expect(coverage.includedFiles).toBe(10);
    expect(coverage.omittedFiles).toBe(16);
    expect(coverage.limitsHit).toEqual(['FILE_LIMIT']);
    expect(result.draft.manifest.frames.at(-1)!.analysisStatus).toBe('partial');
    // Historical frames over the lowered cap are unavailable; the selected commit
    // remains a useful partial graph with exact omissions.
    expect(result.draft.history.frameSelection?.commits.some((f) => f.reason === 'FRAME_RESOURCE_LIMIT')).toBe(true);
    expect(packArtifact(result.draft, gzipDeterministic).manifest.chunks).toHaveLength(result.draft.graphs.length + 2);
  });

  it('changes the options digest (and so every ID) when scope options change', async () => {
    const plain = await run();
    const excluded = await run({ exclude: ['assets/'] });
    expect(excluded.draft.manifest.optionsDigest).not.toBe(plain.draft.manifest.optionsDigest);
    expect(excluded.draft.graphs.at(-1)!.snapshotId).not.toBe(plain.draft.graphs.at(-1)!.snapshotId);
    expect(excluded.draft.graphs.at(-1)!.coverage.reasons).toEqual([{ code: 'CLI_EXCLUDED', count: 2 }]);
  });
});
