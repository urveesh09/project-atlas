import type { ManifestDraft } from '@atlas/artifact';
import { PARSER_VERSION } from '@atlas/analyzer-ts';
import { readCommit, readObjects, listTree, type SafeGit } from '@atlas/ingest';
import { buildingHeight, computeLayout, type LayoutTreeNode } from '@atlas/layout';
import {
  ARTIFACT_VERSION,
  GRAPH_SCHEMA_VERSION,
  LAYOUT_VERSION,
  METRIC_DEFINITION_VERSION,
  compareAscii,
  compareUtf8,
  districtId,
  emptySnapshotCoverage,
  lineageId,
  makeId,
  randomId,
  snapshotId,
  type AnalysisCoverage,
  type GitCommitRef,
  type GraphNode,
  type GraphSnapshot,
  type HistoryArtifact,
  type LayoutArtifact,
  type RepositoryDescriptor,
  type SnapshotCoverage,
} from '@atlas/schema';
import { builtinExclusionPatterns } from './classify.js';
import { AnalysisError } from './errors.js';
import { buildHierarchy } from './hierarchy.js';
import { buildInventory, type Inventory } from './inventory.js';
import { ANALYZER_VERSION, normalizeOptions, optionsDigest, parseRepositoryConfig, type AnalysisOptions, type NormalizedOptions } from './options.js';

/**
 * Analyze one committed snapshot into a complete, validated artifact (Phase 1: structure,
 * packages, configuration and coverage). Parsing (P2), history (P4) and the polished city
 * (P3) extend this same pipeline; nothing here is a placeholder that fakes their output.
 */
export type AnalysisStage = 'resolve' | 'enumerate' | 'inventory' | 'hierarchy' | 'layout' | 'assemble';

export interface ProgressEvent {
  stage: AnalysisStage;
  done?: number;
  total?: number;
}

export interface AnalyzeCommitInput {
  git: SafeGit;
  commitOid: string;
  repository: Omit<RepositoryDescriptor, 'objectFormat'> & { objectFormat: 'sha1' | 'sha256' };
  gitVersion: string;
  options?: AnalysisOptions;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  /** Injectable clock for reproducible tests (wall-clock values never enter chunks). */
  now?: () => Date;
}

export interface AnalysisResult {
  draft: { manifest: ManifestDraft; graphs: GraphSnapshot[]; history: HistoryArtifact; layout: LayoutArtifact };
  status: 'complete' | 'partial';
  summary: AnalysisSummary;
  options: NormalizedOptions;
}

export interface AnalysisSummary {
  tool: 'atlas';
  analyzerVersion: string;
  repository: string;
  commit: string;
  status: 'complete' | 'partial';
  scope: 'committed-tree';
  files: { discovered: number; included: number; supported: number; opaque: number; excluded: number; omitted: number };
  roles: Record<string, number>;
  packages: { name: string | null; path: string; files: number; workspace: boolean }[];
  externalPackages: number;
  exclusions: { reason: string; count: number }[];
  excludedRoots: { path: string; reason: string; files: number }[];
  appliedBuiltinExclusions: { reason: string; patterns: string[] }[];
  limitsHit: string[];
  warnings: { code: string; path: string | null }[];
  history: { status: 'unavailable'; reason: string };
  sourceTextIncluded: false;
}

const isoFromEpoch = (seconds: number) => new Date(seconds * 1000).toISOString();

export async function analyzeCommit(input: AnalyzeCommitInput): Promise<AnalysisResult> {
  const progress = (event: ProgressEvent) => input.onProgress?.(event);
  const options = normalizeOptions(input.options);
  const { git, commitOid } = input;
  const repoId = input.repository.repoId;

  progress({ stage: 'resolve' });
  const commit = await readCommit(git, commitOid, input.signal);
  const commitRef: GitCommitRef = { oid: commitOid, committerTime: isoFromEpoch(commit.committerEpochSeconds), firstParentOid: commit.parents[0] ?? null };

  // Repository-level atlas.config.json is committed data: read it before enumeration.
  progress({ stage: 'enumerate' });
  const configText = await readRootConfig(git, commit.tree, input.signal);
  const repositoryConfig = parseRepositoryConfig(configText);
  const digest = optionsDigest(options, repositoryConfig.digest);
  const snap = snapshotId(repoId, commitOid, ANALYZER_VERSION, digest);

  progress({ stage: 'inventory', done: 0 });
  const inventory = await buildInventory(git, commit.tree, {
    limits: options.limits,
    repositoryExclude: repositoryConfig.exclude,
    cliExclude: options.exclude,
    ...(input.signal ? { signal: input.signal } : {}),
    onProgress: (done, total) => progress({ stage: 'inventory', done, total }),
  });

  progress({ stage: 'hierarchy' });
  const lineageOf = (path: string) => lineageId(repoId, commitOid, commitOid, path);
  const hierarchy = buildHierarchy({ snapshotId: snap, repoDisplayName: input.repository.displayName, inventory, lineageOf });

  const coverage = buildCoverage(inventory, [...repositoryConfig.warnings, ...hierarchy.warnings]);
  const status: 'complete' | 'partial' = inventory.limitsHit.size > 0 ? 'partial' : 'complete';
  const graph: GraphSnapshot = {
    snapshotId: snap,
    repoId,
    commitOid,
    nodes: hierarchy.nodes,
    edges: hierarchy.edges,
    importObservations: [],
    diagnostics: [],
    metrics: [],
    coverage,
  };

  progress({ stage: 'layout' });
  const layout = buildLayout(repoId, snap, graph);

  progress({ stage: 'assemble' });
  const history: HistoryArtifact = {
    historyId: makeId('history', [repoId, commitOid, 'unavailable', digest]),
    frames: [{ snapshotId: snap, commitOid, ordinal: 0 }],
    commits: [],
    lineages: graph.nodes
      .flatMap((n) => (n.kind === 'file' ? [{ id: n.lineageId!, anchorCommitOid: commitOid, anchorPath: n.path, continuity: 'exact-path' as const, occurrences: [{ snapshotId: snap, nodeId: n.id, path: n.path }] }] : []))
      .sort((a, b) => compareAscii(a.id, b.id)),
    coChangePairs: [],
  };
  const analysisCoverage: AnalysisCoverage = {
    head: coverage,
    history: {
      status: 'unavailable',
      requestedDays: options.history.enabled ? options.history.days : 0,
      requestedCommitCap: options.history.enabled ? options.history.commits : 0,
      commitsTraversed: 0,
      framesRequested: 1,
      framesCompleted: 1,
      boundary: 'none',
      oldestOid: null,
      newestOid: commitOid,
      renameDetection: 'unavailable',
      lineDiffs: 'unavailable',
      coChange: 'unavailable',
    },
  };
  const now = (input.now ?? (() => new Date()))();
  const manifest: ManifestDraft = {
    artifactVersion: ARTIFACT_VERSION,
    schemaVersion: GRAPH_SCHEMA_VERSION,
    analysisId: randomId('analysis'),
    analysisKey: makeId('analysisKey', [repoId, commitOid, digest, ANALYZER_VERSION, PARSER_VERSION, METRIC_DEFINITION_VERSION, LAYOUT_VERSION, 'history:unavailable']),
    repo: { ...input.repository },
    selectedCommit: commitRef,
    analyzer: { version: ANALYZER_VERSION, parserVersion: PARSER_VERSION, gitVersion: input.gitVersion },
    optionsDigest: digest,
    metricDefinitionVersion: METRIC_DEFINITION_VERSION,
    frames: [{ snapshotId: snap, commit: commitRef, ordinal: 0, nodeCount: graph.nodes.length, edgeCount: graph.edges.length, analysisStatus: status === 'complete' ? 'complete' : 'partial', coverage }],
    coverage: analysisCoverage,
    createdAt: now.toISOString(),
    expiresAt: null,
    sourceTextIncluded: false,
  };

  return {
    draft: { manifest, graphs: [graph], history, layout },
    status,
    options,
    summary: summarize(input.repository.displayName, commitOid, status, inventory, graph),
  };
}

async function readRootConfig(git: SafeGit, treeOid: string, signal?: AbortSignal): Promise<string | null> {
  // A one-level listing is enough: atlas.config.json is only honored at the root.
  const listing = await listTree(git, treeOid, { maxEntries: 200_000, recursive: false, ...(signal ? { signal } : {}) });
  const entry = listing.entries.find((e) => e.path === 'atlas.config.json' && e.kind === 'blob');
  if (!entry || entry.size === null || entry.size > 64 * 1024) return null;
  const objects = await readObjects(git, [{ oid: entry.oid, size: entry.size }], signal);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(objects.get(entry.oid)!.bytes);
  } catch {
    return null;
  }
}

function buildCoverage(inventory: Inventory, warnings: { code: string; path: string | null }[]): SnapshotCoverage {
  const supported = inventory.files.filter((f) => f.supported).length;
  const unique = new Map<string, { code: string; path: string | null }>();
  for (const w of warnings) unique.set(`${w.code}\u0000${w.path ?? ''}`, w);
  for (const file of inventory.files) if (file.opaqueReason) unique.set(`${file.opaqueReason}\u0000${file.path}`, { code: file.opaqueReason, path: file.path });
  for (const [path, root] of inventory.excludedRoots) if (root.count > 0 && path.length > 0) unique.set(`EXCLUDED_${root.reason}\u0000${path}`, { code: `EXCLUDED_${root.reason}`, path });
  const sortedWarnings = [...unique.values()].sort((a, b) => compareAscii(a.code, b.code) || compareUtf8(a.path ?? '', b.path ?? '')).slice(0, 10_000);
  return {
    ...emptySnapshotCoverage(),
    discoveredFiles: inventory.discovered,
    includedFiles: inventory.files.length,
    supportedFiles: supported,
    parsedFiles: 0,
    parseFailedFiles: 0,
    opaqueFiles: inventory.files.length - supported,
    excludedFiles: inventory.excluded.length,
    omittedFiles: inventory.omitted.length,
    reasons: [...inventory.reasons].map(([code, count]) => ({ code, count })).sort((a, b) => compareAscii(a.code, b.code)),
    limitsHit: [...inventory.limitsHit].sort(),
    warnings: sortedWarnings,
  };
}

function buildLayout(repoId: string, snap: string, graph: GraphSnapshot): LayoutArtifact {
  const byParent = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.parentId === null) continue;
    const list = byParent.get(node.parentId) ?? [];
    list.push(node);
    byParent.set(node.parentId, list);
  }
  const toTree = (node: GraphNode): LayoutTreeNode => {
    const children = byParent.get(node.id) ?? [];
    return {
      kind: node.kind === 'repository' ? 'repository' : node.kind === 'package' ? 'package' : 'directory',
      path: node.kind === 'repository' ? '' : (node as { path: string }).path,
      files: children.filter((c) => c.kind === 'file').map((c) => c.lineageId!),
      children: children.filter((c) => c.kind === 'package' || c.kind === 'directory').map(toTree),
    };
  };
  const repository = graph.nodes.find((n) => n.kind === 'repository')!;
  const externals = graph.nodes.flatMap((n) => (n.kind === 'external-package' ? [`npm:${n.packageName}`] : n.kind === 'builtin' ? [`builtin:${n.moduleName}`] : []));
  const geometry = computeLayout({ repoId, frameKey: snap, externals, root: toTree(repository) });

  const containers = graph.nodes
    .filter((n) => n.kind === 'repository' || n.kind === 'package' || n.kind === 'directory')
    .map((n) => ({ graphNodeId: n.id, layoutDistrictId: districtId(repoId, n.kind as 'repository' | 'package' | 'directory', n.kind === 'repository' ? '' : (n as { path: string }).path) }))
    .sort((a, b) => compareAscii(a.graphNodeId, b.graphNodeId));
  const files = graph.nodes
    .flatMap((n) => (n.kind === 'file' ? [{ nodeId: n.id, lineageId: n.lineageId!, currentParentId: n.parentId!, height: buildingHeight(n.role, n.parseStatus, null), present: true as const }] : []))
    .sort((a, b) => compareAscii(a.lineageId, b.lineageId));
  return { ...geometry, frameState: [{ snapshotId: snap, containers, files }] };
}


function summarize(displayName: string, commitOid: string, status: 'complete' | 'partial', inventory: Inventory, graph: GraphSnapshot): AnalysisSummary {
  const roles: Record<string, number> = {};
  for (const file of inventory.files) roles[file.role] = (roles[file.role] ?? 0) + 1;
  const packages = graph.nodes.filter((n) => n.kind === 'package');
  const filesPerPackage = new Map<string, number>();
  const parent = new Map(graph.nodes.map((n) => [n.id, n.parentId]));
  for (const node of graph.nodes) {
    if (node.kind !== 'file') continue;
    let current = node.parentId;
    while (current && !packages.some((p) => p.id === current)) current = parent.get(current) ?? null;
    if (current) filesPerPackage.set(current, (filesPerPackage.get(current) ?? 0) + 1);
  }
  const c = graph.coverage;
  return {
    tool: 'atlas',
    analyzerVersion: ANALYZER_VERSION,
    repository: displayName,
    commit: commitOid,
    status,
    scope: 'committed-tree',
    files: { discovered: c.discoveredFiles, included: c.includedFiles, supported: c.supportedFiles, opaque: c.opaqueFiles, excluded: c.excludedFiles, omitted: c.omittedFiles },
    roles,
    packages: packages
      .map((p) => (p.kind === 'package' ? { name: p.packageName, path: p.path, files: filesPerPackage.get(p.id) ?? 0, workspace: p.workspace } : null))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => compareUtf8(a.path, b.path)),
    externalPackages: graph.nodes.filter((n) => n.kind === 'external-package').length,
    exclusions: c.reasons.map((r) => ({ reason: r.code, count: r.count })),
    excludedRoots: [...inventory.excludedRoots]
      .map(([path, r]) => ({ path, reason: r.reason, files: r.count }))
      .sort((a, b) => b.files - a.files || compareUtf8(a.path, b.path))
      .slice(0, 50),
    appliedBuiltinExclusions: builtinExclusionPatterns(),
    limitsHit: c.limitsHit,
    warnings: c.warnings.slice(0, 200),
    history: { status: 'unavailable', reason: 'Git history analysis arrives in Phase 4 (P4.1).' },
    sourceTextIncluded: false,
  };
}

export { AnalysisError };
