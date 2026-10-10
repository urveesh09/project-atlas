import {
  ARTIFACT_VERSION,
  GRAPH_SCHEMA_VERSION,
  METRIC_DEFINITION_VERSION,
  canonicalJsonSha256,
  compareAscii,
  districtId,
  edgeId,
  emptySnapshotCoverage,
  lineageId,
  localRepositoryId,
  makeId,
  nodeId,
  observationId,
  snapshotId,
  type ArtifactManifest,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type HistoryArtifact,
  type ImportObservation,
  type LayoutArtifact,
  type NodeMetrics,
  type SourceRange,
} from '@atlas/schema';

/**
 * A hand-written artifact used to prove the contracts (task P0.5). Every value here is
 * authored directly from the plan's definitions, not produced by the analyzer, so it can
 * act as an independent reference for validators and later for serializers.
 *
 * Repository shape (one frame):
 *   package.json                       (root package, synthetic root '')
 *   src/main.ts      imports ./util (value), node:fs (builtin), lodash (external)
 *   src/util.ts      imports type ./main  (type-only)
 *   packages/core/package.json         (workspace package @demo/core)
 *   packages/core/index.ts
 */
export interface HandcraftedArtifact {
  manifest: ArtifactManifest;
  graph: GraphSnapshot;
  history: HistoryArtifact;
  layout: LayoutArtifact;
}

const COMMIT = '1'.repeat(40);
const UUID = '3f2a9c4e-8b1d-4f6a-9c2e-7d5b1a0e4c3f';

function range(startOffset: number, endOffset: number, line: number, startColumn: number, endColumn: number): SourceRange {
  return { startOffset, endOffset, startLine: line, startColumn, endLine: line, endColumn };
}

function metrics(id: string, overrides: Partial<NodeMetrics> = {}): NodeMetrics {
  return {
    nodeId: id,
    physicalLines: null,
    codeLines: null,
    declarationCount: null,
    maxCyclomatic: null,
    sumCyclomatic: null,
    callableCount: null,
    fanIn: null,
    fanOut: null,
    sccId: null,
    changedCommits: null,
    linesAdded: null,
    linesDeleted: null,
    hotspotScore: null,
    availability: { syntax: 'unavailable', dependencies: 'unavailable', history: 'unavailable' },
    ...overrides,
  };
}

export function buildHandcraftedArtifact(): HandcraftedArtifact {
  const repoId = localRepositoryId(UUID);
  const optionsDigest = canonicalJsonSha256({ profile: 'v0.1-default', history: false });
  const snap = snapshotId(repoId, COMMIT, '0.1.0-dev', optionsDigest);
  const id = (kind: Parameters<typeof nodeId>[1], key: string) => nodeId(snap, kind, key);

  const repoNode = id('repository', '');
  const rootPkg = id('package', '');
  const corePkg = id('package', 'packages/core');
  const srcDir = id('directory', 'src');
  const main = id('file', 'src/main.ts');
  const util = id('file', 'src/util.ts');
  const rootManifest = id('file', 'package.json');
  const coreManifest = id('file', 'packages/core/package.json');
  const coreIndex = id('file', 'packages/core/index.ts');
  const lodash = id('external-package', 'lodash');
  const fsBuiltin = id('builtin', 'fs');

  const boundary = COMMIT;
  const lin = (path: string) => lineageId(repoId, boundary, COMMIT, path);

  const file = (
    nodeIdValue: string,
    parentId: string,
    path: string,
    role: 'source' | 'config',
    language: 'typescript' | null,
    byteSize: number,
  ): GraphNode => ({
    id: nodeIdValue,
    kind: 'file',
    label: path.slice(path.lastIndexOf('/') + 1),
    parentId,
    lineageId: lin(path),
    path,
    blobOid: canonicalJsonSha256(path).slice(0, 40),
    blobSha256: canonicalJsonSha256(`blob:${path}`),
    language,
    role,
    byteSize,
    parseStatus: language ? 'parsed' : 'unsupported',
    declarations: [],
    declarationsOmitted: 0,
  });

  const nodes: GraphNode[] = [
    { id: repoNode, kind: 'repository', label: 'demo', parentId: null, lineageId: null },
    { id: rootPkg, kind: 'package', label: 'demo-root', parentId: repoNode, lineageId: null, path: '', manifestPath: 'package.json', packageName: 'demo-root', workspace: true },
    { id: corePkg, kind: 'package', label: '@demo/core', parentId: repoNode, lineageId: null, path: 'packages/core', manifestPath: 'packages/core/package.json', packageName: '@demo/core', workspace: true },
    { id: srcDir, kind: 'directory', label: 'src', parentId: rootPkg, lineageId: null, path: 'src' },
    file(rootManifest, rootPkg, 'package.json', 'config', null, 120),
    file(main, srcDir, 'src/main.ts', 'source', 'typescript', 210),
    file(util, srcDir, 'src/util.ts', 'source', 'typescript', 90),
    file(coreManifest, corePkg, 'packages/core/package.json', 'config', null, 60),
    file(coreIndex, corePkg, 'packages/core/index.ts', 'source', 'typescript', 40),
    { id: lodash, kind: 'external-package', label: 'lodash', parentId: null, lineageId: null, ecosystem: 'npm', packageName: 'lodash', declaredRanges: [{ packageNodeId: rootPkg, field: 'dependencies', range: '^4.17.21' }] },
    { id: fsBuiltin, kind: 'builtin', label: 'node:fs', parentId: null, lineageId: null, moduleName: 'fs' },
  ];
  nodes.sort((a, b) => compareAscii(a.id, b.id));

  const obs = (source: string, kind: ImportObservation['kind'], spec: string, r: SourceRange, status: ImportObservation['status'], target: string | null, confidence: ImportObservation['confidence'], reasonCode: string | null = null): ImportObservation => ({
    id: observationId(snap, source, kind, r, spec),
    sourceId: source,
    kind,
    specifier: spec,
    range: r,
    status,
    targetId: target,
    reasonCode,
    resolverMode: 'bundler/esm',
    confidence,
  });

  const observations: ImportObservation[] = [
    obs(main, 'imports-value', './util', range(20, 28, 1, 21, 29), 'resolved-internal', util, 'exact'),
    obs(main, 'imports-value', 'node:fs', range(50, 59, 2, 21, 30), 'builtin', fsBuiltin, 'exact'),
    obs(main, 'imports-value', 'lodash', range(80, 88, 3, 21, 29), 'resolved-external', lodash, 'exact'),
    obs(main, 'imports-value', './missing', range(110, 121, 4, 21, 32), 'unresolved', null, null, 'LOCAL_TARGET_MISSING'),
    obs(util, 'imports-type', './main', range(25, 33, 1, 26, 34), 'resolved-internal', main, 'exact'),
  ];
  observations.sort((a, b) => compareAscii(a.id, b.id));

  const edges: GraphEdge[] = observations
    .filter((o) => o.targetId !== null)
    .map((o) => ({
      id: edgeId(snap, o.sourceId, o.targetId!, o.kind, o.confidence!),
      sourceId: o.sourceId,
      targetId: o.targetId!,
      kind: o.kind,
      confidence: o.confidence!,
      observationCount: 1,
      evidenceIds: [o.id],
      evidenceOmitted: 0,
    }));
  edges.sort((a, b) => compareAscii(a.id, b.id));

  const unresolved = observations.find((o) => o.status === 'unresolved')!;
  const diagnostics: GraphSnapshot['diagnostics'] = [
    {
      id: makeId('diagnostic', [snap, 'ATLAS_LOCAL_IMPORT_UNRESOLVED', unresolved.id]),
      ruleId: 'ATLAS_LOCAL_IMPORT_UNRESOLVED',
      ruleVersion: 1,
      severity: 'warning',
      category: 'resolution',
      subjectIds: [main],
      range: unresolved.range,
      messageCode: 'LOCAL_IMPORT_UNRESOLVED',
      parameters: { specifier: './missing', reason: 'LOCAL_TARGET_MISSING' },
      evidenceIds: [unresolved.id],
      fingerprint: canonicalJsonSha256(['ATLAS_LOCAL_IMPORT_UNRESOLVED', 1, lin('src/main.ts'), './missing']),
    },
  ];

  const parsedAvailability = { syntax: 'complete', dependencies: 'complete', history: 'unavailable' } as const;
  const metricRows: NodeMetrics[] = [
    metrics(main, { physicalLines: 12, codeLines: 10, declarationCount: 1, maxCyclomatic: 3, sumCyclomatic: 4, callableCount: 2, fanIn: 0, fanOut: 1, availability: parsedAvailability }),
    metrics(util, { physicalLines: 5, codeLines: 4, declarationCount: 1, maxCyclomatic: 1, sumCyclomatic: 1, callableCount: 1, fanIn: 1, fanOut: 0, availability: parsedAvailability }),
    metrics(coreIndex, { physicalLines: 2, codeLines: 2, declarationCount: 1, maxCyclomatic: 0, sumCyclomatic: 0, callableCount: 0, fanIn: 0, fanOut: 0, availability: parsedAvailability }),
  ].sort((a, b) => compareAscii(a.nodeId, b.nodeId));

  const coverage = {
    ...emptySnapshotCoverage(),
    discoveredFiles: 6,
    includedFiles: 5,
    supportedFiles: 3,
    parsedFiles: 3,
    opaqueFiles: 2,
    excludedFiles: 1,
    observedImports: 5,
    internalResolved: 2,
    externalResolved: 1,
    builtinResolved: 1,
    unresolved: 1,
    reasons: [
      { code: 'EXCLUDED_BUILD_OUTPUT', count: 1 },
      { code: 'LOCAL_TARGET_MISSING', count: 1 },
    ],
  };

  const graph: GraphSnapshot = {
    snapshotId: snap,
    repoId,
    commitOid: COMMIT,
    nodes,
    edges,
    importObservations: observations,
    diagnostics,
    metrics: metricRows,
    coverage,
  };

  // Layout: root district 0..2000 x 0..1200, two package districts, five plots.
  const rootDistrict = districtId(repoId, 'repository', '');
  const rootPkgDistrict = districtId(repoId, 'package', '');
  const coreDistrict = districtId(repoId, 'package', 'packages/core');
  const srcDistrict = districtId(repoId, 'directory', 'src');
  const plot = (path: string, district: string, x: number, z: number) => ({
    lineageId: lin(path),
    districtId: district,
    rect: { x, z, width: 100, depth: 100 },
    seed: (parseInt(lin(path).slice(4, 12), 16) >>> 0) || 1,
  });
  const files = [
    { path: 'package.json', node: rootManifest, parent: rootPkg, height: 0.8 },
    { path: 'src/main.ts', node: main, parent: srcDir, height: 1.523 },
    { path: 'src/util.ts', node: util, parent: srcDir, height: 1.234 },
    { path: 'packages/core/package.json', node: coreManifest, parent: corePkg, height: 0.8 },
    { path: 'packages/core/index.ts', node: coreIndex, parent: corePkg, height: 1.115 },
  ];
  const layout: LayoutArtifact = {
    layoutVersion: 'atlas.layout/1.0.0',
    layoutId: makeId('layout', [repoId, snap, 'atlas.layout/1.0.0']),
    unitsPerCell: 100,
    root: { x: 0, z: 0, width: 2000, depth: 1200 },
    districts: [
      { id: rootDistrict, parentId: null, rect: { x: 0, z: 0, width: 2000, depth: 1200 }, anchorPath: '' },
      { id: rootPkgDistrict, parentId: rootDistrict, rect: { x: 100, z: 100, width: 1000, depth: 1000 }, anchorPath: '' },
      { id: srcDistrict, parentId: rootPkgDistrict, rect: { x: 200, z: 400, width: 600, depth: 500 }, anchorPath: 'src' },
      { id: coreDistrict, parentId: rootDistrict, rect: { x: 1300, z: 100, width: 600, depth: 600 }, anchorPath: 'packages/core' },
    ].sort((a, b) => compareAscii(a.id, b.id)),
    plots: [
      plot('package.json', rootPkgDistrict, 200, 200),
      plot('src/main.ts', srcDistrict, 300, 500),
      plot('src/util.ts', srcDistrict, 500, 500),
      plot('packages/core/package.json', coreDistrict, 1400, 300),
      plot('packages/core/index.ts', coreDistrict, 1600, 300),
    ].sort((a, b) => compareAscii(a.lineageId, b.lineageId)),
    externalAnchors: [
      { canonicalName: 'builtin:fs', x: 0, z: -300 },
      { canonicalName: 'npm:lodash', x: 400, z: -300 },
    ],
    frameState: [
      {
        snapshotId: snap,
        containers: [
          { graphNodeId: repoNode, layoutDistrictId: rootDistrict },
          { graphNodeId: rootPkg, layoutDistrictId: rootPkgDistrict },
          { graphNodeId: srcDir, layoutDistrictId: srcDistrict },
          { graphNodeId: corePkg, layoutDistrictId: coreDistrict },
        ],
        files: files.map((f) => ({ nodeId: f.node, lineageId: lin(f.path), currentParentId: f.parent, height: f.height, present: true as const })),
      },
    ],
  };

  const history: HistoryArtifact = {
    historyId: makeId('history', [repoId, COMMIT, 'disabled']),
    frames: [{ snapshotId: snap, commitOid: COMMIT, ordinal: 0 }],
    commits: [],
    lineages: files
      .map((f) => ({
        id: lin(f.path),
        anchorCommitOid: COMMIT,
        anchorPath: f.path,
        continuity: 'exact-path' as const,
        occurrences: [{ snapshotId: snap, nodeId: f.node, path: f.path }],
      }))
      .sort((a, b) => compareAscii(a.id, b.id)),
    coChangePairs: [],
  };

  const chunk = (path: string, value: unknown) => ({
    path,
    sha256: canonicalJsonSha256(value),
    uncompressedBytes: 1000,
    compressedBytes: 400,
    mediaType: 'application/json' as const,
  });
  const graphChunk = chunk(`graphs/${snap}.json.gz`, graph);
  const historyChunk = chunk('history/history.json.gz', history);
  const layoutChunk = chunk('layout/layout.json.gz', layout);
  const commitRef = { oid: COMMIT, committerTime: '2026-10-01T12:00:00Z', firstParentOid: null };

  const manifest: ArtifactManifest = {
    artifactVersion: ARTIFACT_VERSION,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    analysisId: `analysis_${'a'.repeat(64)}`,
    analysisKey: makeId('analysisKey', [repoId, COMMIT, optionsDigest]),
    repo: { repoId, displayName: 'demo', sourceKind: 'local-git', remote: null, objectFormat: 'sha1' },
    selectedCommit: commitRef,
    analyzer: { version: '0.1.0-dev', parserVersion: 'typescript@6.0.3', gitVersion: '2.55.0' },
    optionsDigest,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    frames: [
      {
        snapshotId: snap,
        commit: commitRef,
        ordinal: 0,
        graphChunk,
        nodeCount: nodes.length,
        edgeCount: edges.length,
        analysisStatus: 'complete',
        coverage,
      },
    ],
    historyChunk,
    layoutChunk,
    chunks: [graphChunk, historyChunk, layoutChunk],
    coverage: {
      head: coverage,
      history: {
        status: 'unavailable',
        requestedDays: 0,
        requestedCommitCap: 0,
        commitsTraversed: 0,
        framesRequested: 1,
        framesCompleted: 1,
        boundary: 'none',
        oldestOid: null,
        newestOid: COMMIT,
        renameDetection: 'unavailable',
        lineDiffs: 'unavailable',
        coChange: 'unavailable',
      },
    },
    createdAt: '2026-10-10T00:00:00Z',
    expiresAt: null,
    sourceTextIncluded: false,
  };

  return { manifest, graph, history, layout };
}
