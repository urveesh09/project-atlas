import { ArtifactPackError, packArtifact, type Compressor, type ManifestDraft, type PackedArtifact } from '@atlas/artifact';
import { PARSER_VERSION } from '@atlas/analyzer-ts';
import { churnByFrame, coChangePairs } from '@atlas/history';
import { DIFF_POLICY, isIngestError, listTree, readCommit, readObjects, type CommitObject, type SafeGit } from '@atlas/ingest';
import {
  ARTIFACT_VERSION,
  GRAPH_SCHEMA_VERSION,
  LAYOUT_VERSION,
  LIMITS,
  METRIC_DEFINITION_VERSION,
  compareAscii,
  compareUtf8,
  emptySnapshotCoverage,
  lineageId as deriveLineageId,
  makeId,
  randomId,
  snapshotId,
  type AnalysisCoverage,
  type FileLineage,
  type FrameSelection,
  type GitCommitRef,
  type GraphSnapshot,
  type HistoryArtifact,
  type HistoryCoverage,
  type LayoutArtifact,
  type RepositoryDescriptor,
  type SnapshotCoverage,
} from '@atlas/schema';
import { BlobCache } from './blob-cache.js';
import { builtinExclusionPatterns } from './classify.js';
import { AnalysisError } from './errors.js';
import { MemoryFactCache, type FactCache } from './fact-cache.js';
import { buildHierarchy } from './hierarchy.js';
import { applyHistoryMetrics, applyHotspotsAndHistoryFindings, hotspotBaseline } from './history-metrics.js';
import { historyFailureBoundary, planHistory, toWindowCommit, type HistoryPlan } from './history-plan.js';
import { buildInventory, isPathInScope, scopeRules, type Inventory } from './inventory.js';
import { ANALYZER_VERSION, normalizeOptions, optionsDigest, parseRepositoryConfig, type AnalysisOptions, type NormalizedOptions, type RepositoryConfig } from './options.js';
import { ParserPool } from './parse-pool.js';
import { analyzeStaticSnapshot, type StaticSnapshot } from './static-snapshot.js';
import { buildUnionLayout } from './union-layout.js';

/**
 * Analyze a selected commit and its bounded first-parent history into one validated
 * artifact draft: structure and coverage (Phase 1), parsing, dependencies, metrics and
 * findings (Phase 2), and history (Phase 4): the window and its changes, conservative
 * lineage, sampled structural frames, churn, hotspots and one stable union layout.
 *
 * The selected commit is analyzed first and is the checkpoint: any later history failure
 * (deadline, budgets, missing objects, limits) degrades history explicitly and never the
 * selected commit's graph. Historical frames are complete graphs or are listed as
 * unavailable with a reason; half a frame is never published (plan §7.2).
 */
export type AnalysisStage = 'resolve' | 'history' | 'enumerate' | 'inventory' | 'hierarchy' | 'parse' | 'dependencies' | 'findings' | 'frames' | 'layout' | 'assemble';

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
  /** Shared parser pool (otherwise one is created and closed for this analysis). */
  pool?: ParserPool;
  /** Fact cache (otherwise an in-memory cache for this analysis). */
  factCache?: FactCache;
  /** End-to-end deadline (plan §4.2: 300 s); history degrades first, HEAD fails last. */
  deadlineMs?: number;
  /**
   * Pack with this compressor and fit the export limits (plan §4.2: 20 MiB compressed,
   * decoded cap per ADR-024) by deterministically dropping the oldest historical frames;
   * the selected commit alone exceeding them fails with `ARTIFACT_SIZE`.
   */
  transport?: Compressor;
  /**
   * History was requested but its objects were deliberately not acquired (the hosted
   * HEAD checkpoint, plan §8.3). The result records history as unavailable at a resource
   * boundary with this code, never as disabled and never as a shallow repository.
   */
  historyUnavailable?: { code: 'HISTORY_NOT_ACQUIRED' };
}

export interface AnalysisResult {
  draft: { manifest: ManifestDraft; graphs: GraphSnapshot[]; history: HistoryArtifact; layout: LayoutArtifact };
  status: 'complete' | 'partial';
  summary: AnalysisSummary;
  options: NormalizedOptions;
  /** Present when `transport` was given: the packed artifact that fits the export limits. */
  packed?: PackedArtifact;
}

export interface HistorySummary {
  status: HistoryCoverage['status'];
  boundary: HistoryCoverage['boundary'];
  /** Why history is unavailable or degraded, when it is. */
  reason: string | null;
  commits: number;
  window: { newest: string; oldest: string | null; oldestTime: string | null; newestTime: string };
  frames: { requested: number; completed: number; unavailable: { commit: string; reason: string }[] };
  renames: number;
  renameDetection: HistoryCoverage['renameDetection'];
  lineDiffs: HistoryCoverage['lineDiffs'];
  coChange: HistoryCoverage['coChange'];
  lineages: number;
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
  imports: { observed: number; internal: number; external: number; builtin: number; unresolved: number; unsupported: number; excludedTargets: number };
  parse: { parsed: number; failed: number; cacheHits: number };
  findings: Record<string, number>;
  cycles: number;
  history: HistorySummary;
  sourceTextIncluded: false;
}

interface SnapshotOutcome {
  graph: GraphSnapshot;
  inventory: Inventory;
  analysis: StaticSnapshot;
  status: 'complete' | 'partial';
}

interface LineageBook {
  records: Map<string, Omit<FileLineage, 'occurrences'>>;
  /** Recovery warnings per frame commit (an included path without a planned lineage). */
  recovered: Map<string, string[]>;
}

export async function analyzeCommit(input: AnalyzeCommitInput): Promise<AnalysisResult> {
  const progress = (event: ProgressEvent) => input.onProgress?.(event);
  const options = normalizeOptions(input.options);
  const { git, commitOid } = input;
  const repoId = input.repository.repoId;
  const startedAt = performance.now();
  const deadlineMs = Math.min(input.deadlineMs ?? LIMITS.workerDeadlineMs, LIMITS.workerDeadlineMs);
  const remaining = () => deadlineMs - (performance.now() - startedAt);

  progress({ stage: 'resolve' });
  const headCommit = await readCommit(git, commitOid, input.signal);

  // Repository-level atlas.config.json is committed data, read at the selected commit and
  // applied to every frame, so lineage scope and frame inventories always agree.
  progress({ stage: 'enumerate' });
  const configText = await readRootConfig(git, headCommit.tree, input.signal);
  const repositoryConfig = parseRepositoryConfig(configText);
  const digest = optionsDigest(options, repositoryConfig.digest);
  const rules = scopeRules(repositoryConfig.exclude, options.exclude);
  const inScope = (path: string) => isPathInScope(path, rules);

  // 1. History plan: commits, diffs and lineage (no blob expansion beyond Git's diff).
  let plan: HistoryPlan | null = null;
  let historyFailure: { boundary: HistoryCoverage['boundary']; code: string } | null = null;
  if (options.history.enabled && input.historyUnavailable) {
    historyFailure = { boundary: 'resource-cap', code: input.historyUnavailable.code };
  } else if (options.history.enabled) {
    progress({ stage: 'history' });
    const planDeadline = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(remaining() / 3, 120_000))));
    try {
      plan = await planHistory({
        git,
        repoId,
        head: headCommit,
        days: options.history.days,
        commits: options.history.commits,
        snapshots: options.history.snapshots,
        treeEntries: options.limits.treeEntries,
        inScope,
        signal: input.signal ? AbortSignal.any([input.signal, planDeadline]) : planDeadline,
      });
    } catch (error) {
      if (input.signal?.aborted) throw new AnalysisError('CANCELLED', 'Analysis cancelled');
      historyFailure = planDeadline.aborted ? { boundary: 'resource-cap', code: 'HISTORY_DEADLINE' } : historyFailureBoundary(error);
    }
  }

  const book: LineageBook = { records: new Map(), recovered: new Map() };
  if (plan) for (const [id, record] of plan.lineage.lineages) book.records.set(id, { ...record });
  const lineageFor = (frameOid: string) => {
    const active = plan?.lineage.activeAt.get(frameOid);
    const boundaryOid = plan ? plan.window.at(-1)!.oid : commitOid;
    return (path: string): string => {
      const planned = active?.get(path);
      if (planned) return planned;
      // Without history every file anchors at the selected commit. With history, an
      // included path the plan did not track is recovered at this frame and reported.
      const id = deriveLineageId(repoId, boundaryOid, frameOid, path);
      if (!book.records.has(id)) book.records.set(id, { id, anchorCommitOid: frameOid, anchorPath: path, continuity: 'exact-path' });
      if (plan) book.recovered.set(frameOid, [...(book.recovered.get(frameOid) ?? []), path]);
      return id;
    };
  };

  const pool = input.pool ?? new ParserPool();
  const factCache = input.factCache ?? new MemoryFactCache();
  const blobs = new BlobCache(LIMITS.historyDistinctSourceBytes);
  const context = { git, repoId, displayName: input.repository.displayName, digest, options, repositoryConfig, pool, factCache, blobs };
  const outcomes = new Map<string, SnapshotOutcome>();
  const unavailable = new Map<string, string>();
  try {
    // 2. The selected commit: the checkpoint every later failure falls back to.
    const deadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining())));
    let head: SnapshotOutcome;
    try {
      head = await analyzeSnapshot(context, headCommit, lineageFor(commitOid), input.signal ? AbortSignal.any([input.signal, deadline]) : deadline, progress);
    } catch (error) {
      if (deadline.aborted && !input.signal?.aborted)
        throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', 'The selected commit could not be analyzed within the deadline', { limit: 'DEADLINE' });
      throw error;
    }
    outcomes.set(commitOid, head);

    // 3. Historical frames, newest to oldest, until a budget or the deadline stops them.
    if (plan) {
      blobs.enforce = true;
      const pending = plan.frames.filter((f) => f.commitOid !== commitOid).reverse();
      let stop: string | null = null;
      let done = 0;
      for (const frame of pending) {
        progress({ stage: 'frames', done, total: pending.length });
        done++;
        if (stop === null && remaining() <= 0) stop = 'HISTORY_DEADLINE';
        if (stop !== null) {
          unavailable.set(frame.commitOid, stop);
          continue;
        }
        const frameDeadline = AbortSignal.timeout(Math.max(1, Math.ceil(remaining())));
        const signal = input.signal ? AbortSignal.any([input.signal, frameDeadline]) : frameDeadline;
        try {
          const commit = await readCommit(git, frame.commitOid, signal);
          const outcome = await analyzeSnapshot(context, commit, lineageFor(frame.commitOid), signal, () => undefined);
          // Historical capacity omissions are unavailable frames, not a shortened
          // city masquerading as the requested snapshot (plan §7.2 and P4.3).
          if (outcome.graph.coverage.limitsHit.length > 0) unavailable.set(frame.commitOid, 'FRAME_RESOURCE_LIMIT');
          else outcomes.set(frame.commitOid, outcome);
        } catch (error) {
          if (input.signal?.aborted) throw new AnalysisError('CANCELLED', 'Analysis cancelled');
          const reason = frameDeadline.aborted ? 'HISTORY_DEADLINE' : frameFailureReason(error);
          unavailable.set(frame.commitOid, reason);
          // Budgets and the deadline stop all further (older) frame expansion.
          if (reason === 'HISTORY_DEADLINE' || reason === 'HISTORY_SOURCE_BUDGET') stop = reason;
        }
      }
      progress({ stage: 'frames', done: pending.length, total: pending.length });
    }
  } finally {
    if (!input.pool) await pool.close();
  }

  // 4. Completed frames in chain order; reduce the oldest frames to the lineage cap.
  let frames = plan
    ? plan.frames.filter((f) => outcomes.has(f.commitOid)).map((f) => ({ ...f, outcome: outcomes.get(f.commitOid)! }))
    : [{ commitOid, chainIndex: 0, outcome: outcomes.get(commitOid)! }];
  for (;;) {
    const union = new Set<string>();
    for (const f of frames) for (const n of f.outcome.graph.nodes) if (n.kind === 'file' && n.lineageId) union.add(n.lineageId);
    if (union.size <= LIMITS.historicalUnionLineages || frames.length === 1) break;
    unavailable.set(frames[0]!.commitOid, 'LINEAGE_LIMIT');
    frames = frames.slice(1);
  }

  // 5-8. Metrics, layout, history and manifest for a frame set; re-run if frames are dropped.
  const assembleFrom = (frames: { commitOid: string; chainIndex: number; outcome: SnapshotOutcome }[]): AnalysisResult => {
    // 5. History metrics, the fixed HEAD hotspot baseline and history findings.
    const churn = plan ? churnByFrame(plan.lineage.commits, new Set(frames.map((f) => f.commitOid))) : null;
    let graphs = frames.map((f) => (churn ? applyHistoryMetrics(f.outcome.graph, churn.get(f.commitOid)!) : f.outcome.graph));
    if (churn) {
      const baseline = hotspotBaseline(graphs.at(-1)!);
      graphs = graphs.map((graph, i) => {
        const applied = applyHotspotsAndHistoryFindings(graph, baseline, churn.get(frames[i]!.commitOid)!.commitsInScope);
        return applied.omittedDiagnostics > 0 ? withDiagnosticLimit(applied.graph, applied.omittedDiagnostics) : applied.graph;
      });
    }
    graphs = graphs.map((graph, i) => withRecoveryWarnings(graph, book.recovered.get(frames[i]!.commitOid) ?? []));

    progress({ stage: 'layout' });
    const layout = buildUnionLayout(repoId, graphs);

    progress({ stage: 'assemble' });
    const history = assembleHistory({ repoId, commitOid, digest, plan, frames, graphs, book, unavailable });
    const windowCommits = new Map((plan?.window ?? [toWindowCommit(headCommit)]).map((c) => [c.oid, c]));
    const historyCoverage = buildHistoryCoverage({ options, plan, historyFailure, history, framesCompleted: graphs.length, headOid: commitOid });
    const head = outcomes.get(commitOid)!;
    const headGraph = graphs.at(-1)!;
    const headStatus: 'complete' | 'partial' = headGraph.coverage.limitsHit.length > 0 || headGraph.coverage.parseFailedFiles > 0 ? 'partial' : 'complete';
    // A useful result is partial when the selected commit or the requested history is.
    const status: 'complete' | 'partial' = headStatus === 'partial' || (options.history.enabled && historyCoverage.status !== 'complete') ? 'partial' : 'complete';
    const analysisCoverage: AnalysisCoverage = { head: headGraph.coverage, history: historyCoverage };
    const commitRef = (oid: string): GitCommitRef => {
      const c = windowCommits.get(oid)!;
      return { oid, committerTime: c.committerTime, firstParentOid: c.firstParentOid };
    };
    const now = (input.now ?? (() => new Date()))();
    const manifest: ManifestDraft = {
      artifactVersion: ARTIFACT_VERSION,
      schemaVersion: GRAPH_SCHEMA_VERSION,
      analysisId: randomId('analysis'),
      analysisKey: makeId('analysisKey', [
        repoId,
        commitOid,
        digest,
        ANALYZER_VERSION,
        PARSER_VERSION,
        METRIC_DEFINITION_VERSION,
        LAYOUT_VERSION,
        // The observed boundary keeps a partial run from sharing a complete run's key.
        `history:${historyCoverage.status}:${historyCoverage.boundary}:${historyCoverage.oldestOid ?? ''}:${historyCoverage.framesCompleted}/${historyCoverage.framesRequested}`,
      ]),
      repo: { ...input.repository },
      selectedCommit: commitRef(commitOid),
      analyzer: { version: ANALYZER_VERSION, parserVersion: PARSER_VERSION, gitVersion: input.gitVersion },
      optionsDigest: digest,
      metricDefinitionVersion: METRIC_DEFINITION_VERSION,
      frames: graphs.map((graph, ordinal) => {
        const c = graph.coverage;
        return {
          snapshotId: graph.snapshotId,
          commit: commitRef(graph.commitOid),
          ordinal,
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
          analysisStatus: c.limitsHit.length > 0 || c.parseFailedFiles > 0 ? 'partial' : 'complete',
          coverage: c,
        };
      }),
      coverage: analysisCoverage,
      createdAt: now.toISOString(),
      expiresAt: null,
      sourceTextIncluded: false,
    };

    return {
      draft: { manifest, graphs, history, layout },
      status,
      options,
      summary: summarize({
        displayName: input.repository.displayName,
        commitOid,
        headTime: commitRef(commitOid).committerTime,
        status,
        head,
        headGraph,
        history,
        historyCoverage,
        historyFailure,
        unavailable,
      }),
    };
  };

  let result = assembleFrom(frames);
  if (input.transport) {
    for (;;) {
      try {
        return { ...result, packed: packArtifact(result.draft, input.transport) };
      } catch (error) {
        if (!(error instanceof ArtifactPackError) || !error.issues.some((i) => i.code === 'LIMIT')) throw error;
        if (frames.length === 1) throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', 'The selected commit alone exceeds the artifact export limits', { limit: 'ARTIFACT_SIZE' });
        unavailable.set(frames[0]!.commitOid, 'ARTIFACT_SIZE');
        frames = frames.slice(1);
        result = assembleFrom(frames);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------
// One snapshot
// ---------------------------------------------------------------------------------------

interface SnapshotContext {
  git: SafeGit;
  repoId: string;
  displayName: string;
  digest: string;
  options: NormalizedOptions;
  repositoryConfig: RepositoryConfig;
  pool: ParserPool;
  factCache: FactCache;
  blobs: BlobCache;
}

async function analyzeSnapshot(
  ctx: SnapshotContext,
  commit: CommitObject,
  lineageOf: (path: string) => string,
  signal: AbortSignal,
  progress: (event: ProgressEvent) => void,
): Promise<SnapshotOutcome> {
  const snap = snapshotId(ctx.repoId, commit.oid, ANALYZER_VERSION, ctx.digest);
  progress({ stage: 'inventory', done: 0 });
  const inventory = await buildInventory(ctx.git, commit.tree, {
    limits: ctx.options.limits,
    repositoryExclude: ctx.repositoryConfig.exclude,
    cliExclude: ctx.options.exclude,
    blobs: ctx.blobs,
    signal,
    onProgress: (done, total) => progress({ stage: 'inventory', done, total }),
  });
  progress({ stage: 'hierarchy' });
  const hierarchy = buildHierarchy({ snapshotId: snap, repoDisplayName: ctx.displayName, inventory, lineageOf });
  const structuralCoverage = buildCoverage(inventory, [...ctx.repositoryConfig.warnings, ...hierarchy.warnings]);
  const analysis = await analyzeStaticSnapshot({
    snapshotId: snap,
    repoId: ctx.repoId,
    commitOid: commit.oid,
    inventory,
    hierarchy,
    coverage: structuralCoverage,
    pool: ctx.pool,
    cache: ctx.factCache,
    signal,
    onProgress: (stage, done, total) => progress({ stage, ...(done !== undefined ? { done } : {}), ...(total !== undefined ? { total } : {}) }),
  });
  const coverage = analysis.graph.coverage;
  // Parse failures and caps both mean the result is useful but partial (plan §14.1).
  const status: 'complete' | 'partial' = coverage.limitsHit.length > 0 || coverage.parseFailedFiles > 0 ? 'partial' : 'complete';
  return { graph: analysis.graph, inventory, analysis, status };
}

function frameFailureReason(error: unknown): string {
  if (error instanceof AnalysisError && error.code === 'ANALYSIS_RESOURCE_LIMIT') {
    const limit = error.details['limit'];
    return limit === 'HISTORY_SOURCE_BUDGET' ? 'HISTORY_SOURCE_BUDGET' : limit === 'TREE_ENTRY_LIMIT' ? 'TREE_ENTRY_LIMIT' : 'FRAME_RESOURCE_LIMIT';
  }
  if (isIngestError(error, 'LOCAL_OBJECT_MISSING')) return 'FRAME_OBJECTS_MISSING';
  if (isIngestError(error, 'TIMEOUT')) return 'HISTORY_DEADLINE';
  return 'FRAME_ANALYSIS_FAILED';
}

function withDiagnosticLimit(graph: GraphSnapshot, omitted: number): GraphSnapshot {
  const coverage: SnapshotCoverage = { ...graph.coverage, reasons: [...graph.coverage.reasons], limitsHit: [...graph.coverage.limitsHit] };
  const existing = coverage.reasons.find((r) => r.code === 'DIAGNOSTIC_LIMIT');
  if (existing) existing.count += omitted;
  else coverage.reasons.push({ code: 'DIAGNOSTIC_LIMIT', count: omitted });
  if (!coverage.limitsHit.includes('DIAGNOSTIC_LIMIT')) coverage.limitsHit.push('DIAGNOSTIC_LIMIT');
  coverage.reasons.sort((a, b) => compareAscii(a.code, b.code));
  coverage.limitsHit.sort();
  return { ...graph, coverage };
}

function withRecoveryWarnings(graph: GraphSnapshot, paths: readonly string[]): GraphSnapshot {
  if (paths.length === 0) return graph;
  const warnings = [...graph.coverage.warnings, ...paths.map((path) => ({ code: 'HISTORY_LINEAGE_RECOVERED', path }))]
    .sort((a, b) => compareAscii(a.code, b.code) || compareUtf8(a.path ?? '', b.path ?? ''))
    .slice(0, LIMITS.coverageWarnings);
  return { ...graph, coverage: { ...graph.coverage, warnings } };
}

// ---------------------------------------------------------------------------------------
// History artifact and coverage
// ---------------------------------------------------------------------------------------

function assembleHistory(input: {
  repoId: string;
  commitOid: string;
  digest: string;
  plan: HistoryPlan | null;
  frames: { commitOid: string; chainIndex: number }[];
  graphs: GraphSnapshot[];
  book: LineageBook;
  unavailable: Map<string, string>;
}): HistoryArtifact {
  const { plan, graphs, book } = input;
  const occurrences = new Map<string, FileLineage['occurrences']>();
  for (const graph of graphs)
    for (const node of graph.nodes)
      if (node.kind === 'file' && node.lineageId) {
        const list = occurrences.get(node.lineageId) ?? [];
        list.push({ snapshotId: graph.snapshotId, nodeId: node.id, path: node.path });
        occurrences.set(node.lineageId, list);
      }

  // Lineages present in a frame always survive; lineages seen only in changes (born and
  // gone between frames) fill the remaining capacity in ID order.
  const referenced = new Set<string>();
  for (const commit of plan?.lineage.commits ?? []) for (const change of commit.changes) if (change.lineageId) referenced.add(change.lineageId);
  const transient = [...referenced].filter((id) => !occurrences.has(id)).sort(compareAscii);
  const capacity = Math.max(0, LIMITS.historicalUnionLineages - occurrences.size);
  const keptTransient = new Set(transient.slice(0, capacity));
  const kept = (id: string) => occurrences.has(id) || keptTransient.has(id);
  const lineages: FileLineage[] = [...occurrences.keys(), ...keptTransient]
    .map((id) => ({ ...book.records.get(id)!, occurrences: occurrences.get(id) ?? [] }))
    .sort((a, b) => compareAscii(a.id, b.id));

  const coChange = plan ? coChangePairs(plan.lineage.commits, kept) : null;
  const historyFrames = graphs.map((g, ordinal) => ({ snapshotId: g.snapshotId, commitOid: g.commitOid, ordinal }));
  const frameSelection: FrameSelection | undefined = plan
    ? {
        requested: plan.frames.length,
        windowCommits: plan.window.length,
        commits: plan.frames.map((f) => {
          const analyzed = input.frames.some((g) => g.commitOid === f.commitOid);
          return {
            commitOid: f.commitOid,
            chainIndex: f.chainIndex,
            status: analyzed ? 'analyzed' : 'unavailable',
            reason: analyzed ? null : (input.unavailable.get(f.commitOid) ?? 'FRAME_ANALYSIS_FAILED'),
          };
        }),
      }
    : undefined;
  return {
    historyId: makeId('history', [input.repoId, input.commitOid, input.digest, plan?.window.at(-1)!.oid ?? 'none', ...historyFrames.map((f) => f.snapshotId)]),
    frames: historyFrames,
    commits: (plan?.lineage.commits ?? []).map((c) => ({
      oid: c.oid,
      firstParentOid: c.firstParentOid,
      committerTime: c.committerTime,
      changes: c.changes.map((change) => (change.lineageId && !kept(change.lineageId) ? { ...change, lineageId: null } : change)),
      changesAvailability: c.changesAvailability,
    })),
    lineages,
    coChangePairs: coChange?.pairs ?? [],
    ...(frameSelection ? { frameSelection } : {}),
    ...(plan
      ? {
          policy: {
            firstParentOnly: true as const,
            renameSimilarityPercent: DIFF_POLICY.renameSimilarityPercent,
            renameCandidateLimit: DIFF_POLICY.renameCandidateLimit,
            copies: false as const,
            coChangeMaxFilesPerCommit: LIMITS.coChangeMaxFilesPerCommit,
            coChangeMinTogether: LIMITS.coChangeMinTogether,
            coChangeMaxPartners: LIMITS.coChangeMaxPartners,
            coChangeExcludedCommits: coChange?.excludedCommits ?? 0,
            transientLineagesOmitted: transient.length - keptTransient.size,
          },
        }
      : {}),
  };
}

function buildHistoryCoverage(input: {
  options: NormalizedOptions;
  plan: HistoryPlan | null;
  historyFailure: { boundary: HistoryCoverage['boundary']; code: string } | null;
  history: HistoryArtifact;
  framesCompleted: number;
  headOid: string;
}): HistoryCoverage {
  const { options, plan } = input;
  const requested = { requestedDays: options.history.enabled ? options.history.days : 0, requestedCommitCap: options.history.enabled ? options.history.commits : 0 };
  if (!plan) {
    return {
      status: 'unavailable',
      ...requested,
      commitsTraversed: 0,
      framesRequested: 1,
      framesCompleted: 1,
      boundary: input.historyFailure?.boundary ?? 'none',
      oldestOid: null,
      newestOid: input.headOid,
      renameDetection: 'unavailable',
      lineDiffs: 'unavailable',
      coChange: 'unavailable',
    };
  }
  const coChange = plan.lineage.commits.some((c) => c.changesAvailability !== 'complete' || !c.renamesComplete) ? 'partial' : 'complete';
  const framesRequested = plan.frames.length;
  const degraded =
    plan.boundary === 'shallow' ||
    plan.boundary === 'resource-cap' ||
    plan.lineage.renameDetection !== 'complete' ||
    plan.lineage.lineDiffs !== 'complete' ||
    input.framesCompleted < framesRequested ||
    (input.history.policy?.transientLineagesOmitted ?? 0) > 0;
  return {
    status: degraded ? 'partial' : 'complete',
    ...requested,
    commitsTraversed: plan.window.length,
    framesRequested,
    framesCompleted: input.framesCompleted,
    boundary: plan.boundary,
    oldestOid: plan.window.at(-1)!.oid,
    newestOid: input.headOid,
    renameDetection: plan.lineage.renameDetection,
    lineDiffs: plan.lineage.lineDiffs,
    coChange,
  };
}

// ---------------------------------------------------------------------------------------
// Inventory coverage, configuration and summary
// ---------------------------------------------------------------------------------------

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
  for (const [path, root] of inventory.excludedRoots)
    if (root.count > 0 && path.length > 0) unique.set(`EXCLUDED_${root.reason}\u0000${path}`, { code: `EXCLUDED_${root.reason}`, path });
  const sortedWarnings = [...unique.values()].sort((a, b) => compareAscii(a.code, b.code) || compareUtf8(a.path ?? '', b.path ?? '')).slice(0, LIMITS.coverageWarnings);
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

function summarize(input: {
  displayName: string;
  commitOid: string;
  headTime: string;
  status: 'complete' | 'partial';
  head: SnapshotOutcome;
  headGraph: GraphSnapshot;
  history: HistoryArtifact;
  historyCoverage: HistoryCoverage;
  historyFailure: { code: string } | null;
  unavailable: Map<string, string>;
}): AnalysisSummary {
  const { head, headGraph: graph, history, historyCoverage: hc } = input;
  const inventory = head.inventory;
  const roles: Record<string, number> = {};
  for (const file of inventory.files) roles[file.role] = (roles[file.role] ?? 0) + 1;
  const packages = graph.nodes.filter((n) => n.kind === 'package');
  const packageIds = new Set(packages.map((p) => p.id));
  const filesPerPackage = new Map<string, number>();
  const parent = new Map(graph.nodes.map((n) => [n.id, n.parentId]));
  for (const node of graph.nodes) {
    if (node.kind !== 'file') continue;
    let current = node.parentId;
    while (current && !packageIds.has(current)) current = parent.get(current) ?? null;
    if (current) filesPerPackage.set(current, (filesPerPackage.get(current) ?? 0) + 1);
  }
  const c = graph.coverage;
  const window = history.commits;
  const reason =
    input.historyFailure?.code ??
    (hc.status === 'unavailable' ? 'HISTORY_DISABLED' : hc.status === 'partial' ? (hc.boundary === 'shallow' ? 'HISTORY_SHALLOW_BOUNDARY' : 'HISTORY_PARTIAL') : null);
  return {
    tool: 'atlas',
    analyzerVersion: ANALYZER_VERSION,
    repository: input.displayName,
    commit: input.commitOid,
    status: input.status,
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
    imports: {
      observed: c.observedImports,
      internal: c.internalResolved,
      external: c.externalResolved,
      builtin: c.builtinResolved,
      unresolved: c.unresolved,
      unsupported: c.unsupported,
      excludedTargets: c.excludedTargets,
    },
    parse: { parsed: c.parsedFiles, failed: c.parseFailedFiles, cacheHits: head.analysis.cacheHits },
    findings: graph.diagnostics.reduce<Record<string, number>>((acc, d) => ((acc[d.ruleId] = (acc[d.ruleId] ?? 0) + 1), acc), {}),
    cycles: head.analysis.cycles,
    history: {
      status: hc.status,
      boundary: hc.boundary,
      reason,
      commits: hc.commitsTraversed,
      window: {
        newest: input.commitOid,
        oldest: hc.oldestOid,
        oldestTime: window.at(-1)?.committerTime ?? null,
        newestTime: input.headTime,
      },
      frames: {
        requested: hc.framesRequested,
        completed: hc.framesCompleted,
        unavailable: [...input.unavailable].map(([commit, why]) => ({ commit, reason: why })),
      },
      renames: window.reduce((sum, commit) => sum + commit.changes.filter((ch) => ch.kind === 'rename').length, 0),
      renameDetection: hc.renameDetection,
      lineDiffs: hc.lineDiffs,
      coChange: hc.coChange,
      lineages: history.lineages.length,
    },
    sourceTextIncluded: false,
  };
}

export { AnalysisError };
