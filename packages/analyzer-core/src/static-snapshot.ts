import type { SyntaxFacts as FileFacts } from './facts.js';
import { aggregateEdges, findStaticCycles } from '@atlas/graph';
import { compareAscii, type GraphNode, type GraphSnapshot, type SnapshotCoverage } from '@atlas/schema';
import { buildObservations, parseSupportedFiles } from './dependencies.js';
import { AnalysisError } from './errors.js';
import type { FactCache } from './fact-cache.js';
import type { HierarchyResult } from './hierarchy.js';
import type { Inventory } from './inventory.js';
import { computeMetrics } from './metrics.js';
import type { ParserPool } from './parse-pool.js';
import { evaluateRules } from './rules.js';
import { boundSnapshotEdges } from './edge-budget.js';

/**
 * Static analysis of one snapshot (Phase 2): parse → resolve → aggregate → cycles →
 * metrics → findings, on top of the structural hierarchy. Pure apart from the pool and
 * cache it is handed; the output graph is validated by the artifact packer.
 */
export interface StaticSnapshot {
  graph: GraphSnapshot;
  facts: Map<string, FileFacts>;
  cacheHits: number;
  cycles: number;
}

export async function analyzeStaticSnapshot(input: {
  snapshotId: string;
  repoId: string;
  commitOid: string;
  inventory: Inventory;
  hierarchy: HierarchyResult;
  coverage: SnapshotCoverage;
  pool: ParserPool;
  cache: FactCache;
  signal?: AbortSignal;
  onProgress?: (stage: 'parse' | 'dependencies' | 'findings', done?: number, total?: number) => void;
}): Promise<StaticSnapshot> {
  const { snapshotId: snap, hierarchy, inventory } = input;
  input.onProgress?.('parse', 0, inventory.files.filter((f) => f.supported).length);
  const parsed = await parseSupportedFiles(inventory.files, input.pool, input.cache, (d, t) => input.onProgress?.('parse', d, t), input.signal);
  if (input.signal?.aborted) throw new AnalysisError('CANCELLED', 'Analysis cancelled');

  input.onProgress?.('dependencies');
  const declaredExternals = new Map<string, GraphNode>();
  for (const node of hierarchy.nodes) if (node.kind === 'external-package') declaredExternals.set(node.ecosystem === 'pypi' ? `pypi:${node.packageName}` : node.packageName, node);
  const { observations, perimeterNodes } = buildObservations({ snapshotId: snap, facts: parsed.facts, resolver: hierarchy.resolver, pythonResolver: hierarchy.pythonResolver, fileNodeIds: hierarchy.fileNodeIds, declaredExternals });
  const aggregation = aggregateEdges(snap, observations);
  const boundedEdges = boundSnapshotEdges(hierarchy.edges, aggregation);

  // File nodes gain their parse status and declarations.
  const nodes: GraphNode[] = hierarchy.nodes.map((node) => {
    if (node.kind !== 'file') return node;
    const facts = parsed.facts.get(node.path);
    if (!facts) return node;
    return { ...node, parseStatus: facts.parseStatus, declarations: facts.declarations, declarationsOmitted: facts.declarationsOmitted };
  });
  nodes.push(...perimeterNodes);
  nodes.sort((a, b) => compareAscii(a.id, b.id));

  const coverage: SnapshotCoverage = { ...input.coverage, reasons: [...input.coverage.reasons], limitsHit: [...input.coverage.limitsHit] };
  const reason = (code: string, count: number) => {
    if (count <= 0) return;
    const existing = coverage.reasons.find((r) => r.code === code);
    if (existing) existing.count += count;
    else coverage.reasons.push({ code, count });
  };
  let parsedCount = 0;
  let failedCount = 0;
  for (const facts of parsed.facts.values()) {
    if (facts.parseStatus === 'parsed') parsedCount++;
    else {
      failedCount++;
      reason(`PARSE_${facts.failureReason ?? 'FAILED'}`, 1);
    }
  }
  const count = (status: string) => observations.filter((o) => o.status === status).length;
  Object.assign(coverage, {
    parsedFiles: parsedCount,
    parseFailedFiles: failedCount,
    observedImports: observations.length,
    internalResolved: count('resolved-internal'),
    externalResolved: count('resolved-external'),
    builtinResolved: count('builtin'),
    unresolved: count('unresolved'),
    unsupported: count('unsupported'),
    excludedTargets: count('excluded-target'),
  });
  const limits: { limit: string; count: number; stage: string }[] = [];
  if (inventory.omitted.length > 0) limits.push({ limit: 'FILE_LIMIT', count: inventory.omitted.length, stage: 'inventory' });
  const budgetOpaque = inventory.files.filter((f) => f.opaqueReason === 'SOURCE_BUDGET').length;
  if (budgetOpaque > 0) limits.push({ limit: 'SOURCE_BUDGET', count: budgetOpaque, stage: 'inventory' });
  if (boundedEdges.edgesOmitted > 0) {
    limits.push({ limit: 'EDGE_LIMIT', count: boundedEdges.edgesOmitted, stage: 'dependencies' });
    reason('EDGE_LIMIT', boundedEdges.edgesOmitted);
    reason('EDGE_RELATIONSHIPS_OMITTED', boundedEdges.relationshipsOmitted);
  }
  if (aggregation.observationsOmitted > 0) {
    limits.push({ limit: 'EVIDENCE_LIMIT', count: aggregation.observationsOmitted, stage: 'dependencies' });
    reason('EVIDENCE_LIMIT', aggregation.observationsOmitted);
  }
  for (const l of limits) if (!coverage.limitsHit.includes(l.limit)) coverage.limitsHit.push(l.limit);

  const draft: GraphSnapshot = {
    snapshotId: snap,
    repoId: input.repoId,
    commitOid: input.commitOid,
    nodes,
    edges: boundedEdges.edges,
    importObservations: aggregation.observations,
    diagnostics: [],
    metrics: [],
    coverage,
  };

  input.onProgress?.('findings');
  const cycles = findStaticCycles(draft);
  const metrics = computeMetrics(draft, parsed.facts, cycles);
  const { diagnostics, omitted } = evaluateRules({ snapshot: draft, facts: parsed.facts, metrics, cycles, limits });
  if (omitted > 0) {
    coverage.limitsHit.push('DIAGNOSTIC_LIMIT');
    reason('DIAGNOSTIC_LIMIT', omitted);
  }
  coverage.reasons.sort((a, b) => compareAscii(a.code, b.code));
  coverage.limitsHit.sort();
  return { graph: { ...draft, metrics, diagnostics, coverage }, facts: parsed.facts, cacheHits: parsed.cacheHits, cycles: cycles.length };
}
