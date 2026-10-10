import { z } from 'zod';
import { compareAscii, compareUtf8 } from './canonical.js';
import { ArtifactManifestSchema, type ArtifactManifest } from './artifact.js';
import { FILE_EDGE_KINDS, GraphSnapshotSchema, type GraphNode, type GraphSnapshot } from './graph.js';
import { HistoryArtifactSchema, type HistoryArtifact } from './history.js';
import { LayoutArtifactSchema, type LayoutArtifact, type Rect } from './layout.js';
import { LIMITS } from './limits.js';
import { repoDirname } from './paths.js';

/**
 * Semantic validation beyond shape (plan §6.1, §16.2). Validators never throw on bad
 * input; they return every issue found (bounded) so callers can report precisely.
 */
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

const MAX_ISSUES = 200;

class IssueSink {
  readonly issues: ValidationIssue[] = [];
  add(code: string, path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ code, path, message });
  }
  get full(): boolean {
    return this.issues.length >= MAX_ISSUES;
  }
}

function fromZod(error: z.ZodError): ValidationIssue[] {
  return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
    code: 'SCHEMA',
    path: issue.path.map(String).join('.') || '$',
    message: issue.message,
  }));
}

function checkSortedUnique<T>(sink: IssueSink, items: readonly T[], key: (item: T) => string, path: string): void {
  for (let i = 1; i < items.length; i++) {
    const order = compareAscii(key(items[i - 1]!), key(items[i]!));
    if (order === 0) sink.add('DUPLICATE_ID', `${path}[${i}]`, `Duplicate key ${key(items[i]!)}`);
    else if (order > 0) sink.add('UNSORTED', `${path}[${i}]`, `${path} must be sorted by its documented key`);
    if (sink.full) return;
  }
}

const CONTAINER_KINDS = new Set(['repository', 'package', 'directory']);

function nodePath(node: GraphNode): string | null {
  return node.kind === 'package' || node.kind === 'directory' || node.kind === 'file' ? node.path : null;
}

export function validateGraphSnapshot(input: unknown, objectFormat?: 'sha1' | 'sha256'): ValidationResult<GraphSnapshot> {
  const parsed = GraphSnapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const snapshot = parsed.data;
  const sink = new IssueSink();
  const oidLength = objectFormat === 'sha256' ? 64 : objectFormat === 'sha1' ? 40 : null;

  // Collections are sorted by ID (metrics by nodeId) and IDs are unique.
  checkSortedUnique(sink, snapshot.nodes, (n) => n.id, 'nodes');
  checkSortedUnique(sink, snapshot.edges, (e) => e.id, 'edges');
  checkSortedUnique(sink, snapshot.importObservations, (o) => o.id, 'importObservations');
  checkSortedUnique(sink, snapshot.diagnostics, (d) => d.id, 'diagnostics');
  checkSortedUnique(sink, snapshot.metrics, (m) => m.nodeId, 'metrics');

  if (oidLength !== null && snapshot.commitOid.length !== oidLength) {
    sink.add('OBJECT_FORMAT', 'commitOid', `Commit OID does not match ${objectFormat}`);
  }

  const nodes = new Map<string, GraphNode>();
  for (const node of snapshot.nodes) nodes.set(node.id, node);

  // Hierarchy: exactly one repository root; containers form a tree by parentId.
  const repositories = snapshot.nodes.filter((n) => n.kind === 'repository');
  if (repositories.length !== 1) sink.add('REPOSITORY_ROOT', 'nodes', `Expected exactly one repository node, found ${repositories.length}`);
  const filePaths = new Set<string>();
  const containerPaths = new Map<string, string>();
  let fileCount = 0;
  snapshot.nodes.forEach((node, i) => {
    const at = `nodes[${i}]`;
    if (node.lineageId !== null && node.kind !== 'file') sink.add('LINEAGE_KIND', at, 'Only file nodes carry lineage IDs');
    switch (node.kind) {
      case 'repository':
      case 'external-package':
      case 'builtin':
        if (node.parentId !== null) sink.add('PARENT', at, `${node.kind} nodes have no parent`);
        break;
      case 'package': {
        const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
        if (!parent || parent.kind !== 'repository') sink.add('PARENT', at, 'Packages are children of the repository node');
        if (containerPaths.has(node.path)) sink.add('DUPLICATE_PATH', at, `Duplicate container path "${node.path}"`);
        containerPaths.set(node.path, node.id);
        break;
      }
      case 'directory':
      case 'file': {
        const parent = node.parentId === null ? undefined : nodes.get(node.parentId);
        if (!parent || (parent.kind !== 'package' && parent.kind !== 'directory')) {
          sink.add('PARENT', at, `${node.kind} must be parented by a package or directory`);
        } else if (parent.path !== repoDirname(node.path)) {
          sink.add('PARENT_PATH', at, `Parent path "${parent.path}" is not the directory of "${node.path}"`);
        }
        if (node.kind === 'directory') {
          if (containerPaths.has(node.path)) sink.add('DUPLICATE_PATH', at, `Duplicate container path "${node.path}"`);
          containerPaths.set(node.path, node.id);
        } else {
          fileCount++;
          if (filePaths.has(node.path)) sink.add('DUPLICATE_PATH', at, `Duplicate file path "${node.path}"`);
          filePaths.add(node.path);
          if (oidLength !== null && node.blobOid.length !== oidLength) sink.add('OBJECT_FORMAT', at, 'Blob OID does not match object format');
          if (node.declarations.length > LIMITS.declarationsPerFile) sink.add('LIMIT', at, 'Too many declarations');
          if (node.parseStatus !== 'parsed' && node.parseStatus !== 'failed' && node.declarations.length > 0) {
            sink.add('DECLARATIONS', at, 'Unparsed files cannot carry declarations');
          }
          for (let d = 1; d < node.declarations.length; d++) {
            if (node.declarations[d - 1]!.range.startOffset > node.declarations[d]!.range.startOffset) {
              sink.add('UNSORTED', `${at}.declarations`, 'Declarations are sorted by source position');
              break;
            }
          }
        }
        break;
      }
    }
  });
  if (fileCount > LIMITS.includedFilesPerSnapshot) sink.add('LIMIT', 'nodes', 'Too many file nodes');
  // A file path can never also be a container path.
  for (const path of filePaths) if (containerPaths.has(path)) sink.add('PATH_KIND', 'nodes', `"${path}" is both a file and a container`);

  // Parent chains terminate at the repository without cycles.
  for (const node of snapshot.nodes) {
    let current: GraphNode | undefined = node;
    let depth = 0;
    while (current && current.parentId !== null) {
      current = nodes.get(current.parentId);
      if (++depth > LIMITS.directoryNesting + 8 && current) {
        sink.add('PARENT_CYCLE', node.id, 'Parent chain is cyclic or too deep');
        break;
      }
    }
    if (sink.full) break;
  }

  // Observations reference their source and (when resolved) a target of the right kind.
  const observations = new Map(snapshot.importObservations.map((o) => [o.id, o]));
  const statusCounts = { internal: 0, external: 0, builtin: 0, unresolved: 0, unsupported: 0, excluded: 0 };
  snapshot.importObservations.forEach((obs, i) => {
    const at = `importObservations[${i}]`;
    const source = nodes.get(obs.sourceId);
    if (!source || source.kind !== 'file') sink.add('DANGLING', at, 'Observation source must be a file node');
    if (!(FILE_EDGE_KINDS as readonly string[]).includes(obs.kind)) sink.add('KIND', at, `${obs.kind} is not a file import kind`);
    const target = obs.targetId === null ? undefined : nodes.get(obs.targetId);
    const resolved = obs.status === 'resolved-internal' || obs.status === 'resolved-external' || obs.status === 'builtin';
    if (resolved) {
      const expected = obs.status === 'resolved-internal' ? 'file' : obs.status === 'resolved-external' ? 'external-package' : 'builtin';
      if (!target || target.kind !== expected) sink.add('DANGLING', at, `${obs.status} observation must target a ${expected} node`);
      if (obs.confidence === null) sink.add('CONFIDENCE', at, 'Resolved observations carry a confidence');
    } else {
      if (obs.targetId !== null) sink.add('TARGET', at, `${obs.status} observations have no target`);
      if (obs.confidence !== null) sink.add('CONFIDENCE', at, 'Unresolved observations carry no confidence');
      if (obs.reasonCode === null) sink.add('REASON', at, `${obs.status} observations carry a reason code`);
    }
    if (obs.status === 'resolved-internal') statusCounts.internal++;
    else if (obs.status === 'resolved-external') statusCounts.external++;
    else if (obs.status === 'builtin') statusCounts.builtin++;
    else if (obs.status === 'unresolved') statusCounts.unresolved++;
    else if (obs.status === 'unsupported') statusCounts.unsupported++;
    else statusCounts.excluded++;
  });

  // Edges aggregate observations with identical (source, target, kind, confidence).
  const edgeKeys = new Set<string>();
  snapshot.edges.forEach((edge, i) => {
    const at = `edges[${i}]`;
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (!source || !target) {
      sink.add('DANGLING', at, 'Edge endpoints must exist');
      return;
    }
    const key = `${edge.sourceId}|${edge.targetId}|${edge.kind}|${edge.confidence}`;
    if (edgeKeys.has(key)) sink.add('DUPLICATE_EDGE', at, 'Edges must be aggregated by source, target, kind and confidence');
    edgeKeys.add(key);
    if ((FILE_EDGE_KINDS as readonly string[]).includes(edge.kind)) {
      if (source.kind !== 'file') sink.add('EDGE_SOURCE', at, 'File dependency edges start at a file');
      if (target.kind !== 'file' && target.kind !== 'external-package' && target.kind !== 'builtin') {
        sink.add('EDGE_TARGET', at, 'File dependency edges target a file or perimeter node');
      }
      if (edge.observationCount !== edge.evidenceIds.length + edge.evidenceOmitted) {
        sink.add('EVIDENCE_COUNT', at, 'observationCount must equal retained plus omitted evidence');
      }
    } else {
      if (source.kind !== 'package') sink.add('EDGE_SOURCE', at, `${edge.kind} edges start at a package`);
      if (target.kind !== 'package' && target.kind !== 'external-package') sink.add('EDGE_TARGET', at, `${edge.kind} edges target a package`);
      if (edge.kind === 'project-reference' && target.kind !== 'package') sink.add('EDGE_TARGET', at, 'Project references target packages');
    }
    for (let e = 0; e < edge.evidenceIds.length; e++) {
      const id = edge.evidenceIds[e]!;
      if (e > 0 && compareAscii(edge.evidenceIds[e - 1]!, id) >= 0) sink.add('UNSORTED', `${at}.evidenceIds`, 'Evidence IDs are sorted and unique');
      const obs = observations.get(id);
      if (!obs) sink.add('DANGLING', `${at}.evidenceIds[${e}]`, 'Evidence observation missing');
      else if (obs.sourceId !== edge.sourceId || obs.targetId !== edge.targetId || obs.kind !== edge.kind || obs.confidence !== edge.confidence) {
        sink.add('EVIDENCE_MISMATCH', `${at}.evidenceIds[${e}]`, 'Evidence does not match its edge');
      }
    }
  });

  snapshot.diagnostics.forEach((diag, i) => {
    for (const subject of diag.subjectIds) if (!nodes.has(subject)) sink.add('DANGLING', `diagnostics[${i}]`, 'Diagnostic subject missing');
    for (const evidence of diag.evidenceIds) if (!observations.has(evidence)) sink.add('DANGLING', `diagnostics[${i}]`, 'Diagnostic evidence missing');
  });

  snapshot.metrics.forEach((metric, i) => {
    const node = nodes.get(metric.nodeId);
    if (!node || !(CONTAINER_KINDS.has(node.kind) || node.kind === 'file')) sink.add('DANGLING', `metrics[${i}]`, 'Metrics belong to file or container nodes');
    if (metric.maxCyclomatic !== null && metric.sumCyclomatic !== null && metric.maxCyclomatic > metric.sumCyclomatic) {
      sink.add('METRIC_RANGE', `metrics[${i}]`, 'maxCyclomatic cannot exceed sumCyclomatic');
    }
    if (metric.hotspotScore !== null && metric.availability.history === 'unavailable') {
      sink.add('METRIC_AVAILABILITY', `metrics[${i}]`, 'A hotspot score requires usable history');
    }
  });

  // Coverage accounting must agree with the graph it describes.
  const c = snapshot.coverage;
  if (c.includedFiles !== fileCount) sink.add('COVERAGE', 'coverage.includedFiles', `includedFiles=${c.includedFiles} but graph has ${fileCount} file nodes`);
  if (c.includedFiles > c.discoveredFiles) sink.add('COVERAGE', 'coverage', 'includedFiles cannot exceed discoveredFiles');
  if (c.parsedFiles + c.parseFailedFiles > c.supportedFiles) sink.add('COVERAGE', 'coverage', 'parsed + failed cannot exceed supported');
  const resolvedSum = c.internalResolved + c.externalResolved + c.builtinResolved + c.unresolved + c.unsupported + c.excludedTargets;
  if (resolvedSum !== c.observedImports) sink.add('COVERAGE', 'coverage', 'Import status counts must sum to observedImports');
  if (snapshot.importObservations.length > c.observedImports) sink.add('COVERAGE', 'coverage', 'More observations than observedImports');
  if (snapshot.importObservations.length === c.observedImports) {
    const mismatch =
      statusCounts.internal !== c.internalResolved ||
      statusCounts.external !== c.externalResolved ||
      statusCounts.builtin !== c.builtinResolved ||
      statusCounts.unresolved !== c.unresolved ||
      statusCounts.unsupported !== c.unsupported ||
      statusCounts.excluded !== c.excludedTargets;
    if (mismatch) sink.add('COVERAGE', 'coverage', 'Status counts disagree with observations');
  }
  for (let r = 1; r < c.reasons.length; r++) {
    if (compareAscii(c.reasons[r - 1]!.code, c.reasons[r]!.code) >= 0) sink.add('UNSORTED', 'coverage.reasons', 'Reasons are sorted by unique code');
  }
  for (let w = 1; w < c.warnings.length; w++) {
    const a = c.warnings[w - 1]!;
    const b = c.warnings[w]!;
    const order = compareAscii(a.code, b.code) || compareUtf8(a.path ?? '', b.path ?? '');
    if (order > 0) sink.add('UNSORTED', 'coverage.warnings', 'Warnings are sorted by code then path');
  }

  return sink.issues.length === 0 ? { ok: true, value: snapshot } : { ok: false, issues: sink.issues };
}

function rectContains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.z >= outer.z && inner.x + inner.width <= outer.x + outer.width && inner.z + inner.depth <= outer.z + outer.depth;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.z < b.z + b.depth && b.z < a.z + a.depth;
}

export function validateLayoutArtifact(input: unknown): ValidationResult<LayoutArtifact> {
  const parsed = LayoutArtifactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const layout = parsed.data;
  const sink = new IssueSink();
  const districts = new Map(layout.districts.map((d) => [d.id, d]));
  if (districts.size !== layout.districts.length) sink.add('DUPLICATE_ID', 'districts', 'Duplicate district IDs');
  checkSortedUnique(sink, layout.districts, (d) => d.id, 'districts');
  checkSortedUnique(sink, layout.plots, (p) => p.lineageId, 'plots');
  const roots = layout.districts.filter((d) => d.parentId === null);
  if (layout.districts.length > 0 && roots.length !== 1) sink.add('DISTRICT_ROOT', 'districts', 'Exactly one root district is required');
  for (const district of layout.districts) {
    if (!rectContains(layout.root, district.rect)) sink.add('CONTAINMENT', district.id, 'District escapes the root rectangle');
    if (district.parentId !== null) {
      const parent = districts.get(district.parentId);
      if (!parent) sink.add('DANGLING', district.id, 'Parent district missing');
      else if (!rectContains(parent.rect, district.rect)) sink.add('CONTAINMENT', district.id, 'District escapes its parent');
    }
  }
  // Sibling districts never overlap.
  const byParent = new Map<string | null, Rect[]>();
  for (const d of layout.districts) {
    const list = byParent.get(d.parentId) ?? [];
    list.push(d.rect);
    byParent.set(d.parentId, list);
  }
  for (const [parent, rects] of byParent) {
    const sorted = [...rects].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length && !sink.full; i++) {
      for (let j = i + 1; j < sorted.length && sorted[j]!.x < sorted[i]!.x + sorted[i]!.width; j++) {
        if (rectsOverlap(sorted[i]!, sorted[j]!)) sink.add('OVERLAP', String(parent), 'Sibling districts overlap');
      }
    }
  }
  // Plots: one per lineage, inside their district, never overlapping (sweep on x).
  for (const plot of layout.plots) {
    const district = districts.get(plot.districtId);
    if (!district) sink.add('DANGLING', plot.lineageId, 'Plot district missing');
    else if (!rectContains(district.rect, plot.rect)) sink.add('CONTAINMENT', plot.lineageId, 'Plot escapes its district');
  }
  const plots = [...layout.plots].sort((a, b) => a.rect.x - b.rect.x || a.rect.z - b.rect.z);
  for (let i = 0; i < plots.length && !sink.full; i++) {
    const a = plots[i]!.rect;
    for (let j = i + 1; j < plots.length && plots[j]!.rect.x < a.x + a.width; j++) {
      if (rectsOverlap(a, plots[j]!.rect)) sink.add('OVERLAP', plots[i]!.lineageId, 'Plots overlap');
    }
  }
  const plotLineages = new Set(layout.plots.map((p) => p.lineageId));
  layout.frameState.forEach((frame, f) => {
    const seen = new Set<string>();
    for (const file of frame.files) {
      if (!plotLineages.has(file.lineageId)) sink.add('DANGLING', `frameState[${f}]`, 'Frame file has no plot');
      if (seen.has(file.lineageId)) sink.add('DUPLICATE_ID', `frameState[${f}]`, 'Lineage present twice in one frame');
      seen.add(file.lineageId);
    }
    for (const container of frame.containers) {
      if (container.layoutDistrictId !== null && !districts.has(container.layoutDistrictId)) {
        sink.add('DANGLING', `frameState[${f}]`, 'Container maps to a missing district');
      }
    }
  });
  return sink.issues.length === 0 ? { ok: true, value: layout } : { ok: false, issues: sink.issues };
}

export function validateHistoryArtifact(input: unknown): ValidationResult<HistoryArtifact> {
  const parsed = HistoryArtifactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const history = parsed.data;
  const sink = new IssueSink();
  checkSortedUnique(sink, history.lineages, (l) => l.id, 'lineages');
  history.frames.forEach((frame, i) => {
    if (frame.ordinal !== i) sink.add('ORDINAL', `frames[${i}]`, 'Frame ordinals are contiguous from 0 (oldest)');
  });
  // Commits are listed newest to oldest along the first-parent chain.
  for (let i = 1; i < history.commits.length; i++) {
    if (history.commits[i - 1]!.firstParentOid !== history.commits[i]!.oid) {
      sink.add('CHAIN', `commits[${i}]`, 'Commits must form a contiguous first-parent chain, newest first');
    }
  }
  const lineages = new Set(history.lineages.map((l) => l.id));
  for (const commit of history.commits) {
    for (const change of commit.changes) {
      if (change.lineageId !== null && !lineages.has(change.lineageId)) sink.add('DANGLING', commit.oid, 'Change references unknown lineage');
      const expectOld = change.kind !== 'add';
      const expectNew = change.kind !== 'delete';
      if ((change.oldPath !== null) !== expectOld || (change.newPath !== null) !== expectNew) {
        sink.add('CHANGE_SHAPE', commit.oid, `A ${change.kind} change has ${expectOld ? 'an' : 'no'} old path and ${expectNew ? 'a' : 'no'} new path`);
      }
      if (change.kind !== 'rename' && change.renameSimilarity !== null) sink.add('CHANGE_SHAPE', commit.oid, 'Only renames carry similarity');
    }
  }
  const pairs = new Set<string>();
  for (const pair of history.coChangePairs) {
    const key = `${pair.aLineageId}|${pair.bLineageId}`;
    if (pairs.has(key)) sink.add('DUPLICATE_ID', 'coChangePairs', 'Duplicate co-change pair');
    pairs.add(key);
    if (!lineages.has(pair.aLineageId) || !lineages.has(pair.bLineageId)) sink.add('DANGLING', 'coChangePairs', 'Pair references unknown lineage');
  }
  return sink.issues.length === 0 ? { ok: true, value: history } : { ok: false, issues: sink.issues };
}

export function validateManifest(input: unknown): ValidationResult<ArtifactManifest> {
  const parsed = ArtifactManifestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, issues: fromZod(parsed.error) };
  const manifest = parsed.data;
  const sink = new IssueSink();
  const chunkPaths = new Set<string>();
  let uncompressed = 0;
  let compressed = 0;
  for (const chunk of manifest.chunks) {
    if (chunkPaths.has(chunk.path)) sink.add('DUPLICATE_CHUNK', chunk.path, 'Duplicate chunk path');
    chunkPaths.add(chunk.path);
    uncompressed += chunk.uncompressedBytes;
    compressed += chunk.compressedBytes;
  }
  if (uncompressed > LIMITS.artifactUncompressedBytes) sink.add('LIMIT', 'chunks', 'Artifact exceeds the uncompressed size limit');
  if (compressed > LIMITS.artifactCompressedBytes) sink.add('LIMIT', 'chunks', 'Artifact exceeds the compressed transport limit');
  const listed = (path: string, sha: string) => manifest.chunks.some((c) => c.path === path && c.sha256 === sha);
  if (manifest.historyChunk.path !== 'history/history.json.gz' || !listed(manifest.historyChunk.path, manifest.historyChunk.sha256)) {
    sink.add('CHUNK_REF', 'historyChunk', 'historyChunk must be history/history.json.gz and listed in chunks');
  }
  if (manifest.layoutChunk.path !== 'layout/layout.json.gz' || !listed(manifest.layoutChunk.path, manifest.layoutChunk.sha256)) {
    sink.add('CHUNK_REF', 'layoutChunk', 'layoutChunk must be layout/layout.json.gz and listed in chunks');
  }
  const snapshots = new Set<string>();
  manifest.frames.forEach((frame, i) => {
    if (frame.ordinal !== i) sink.add('ORDINAL', `frames[${i}]`, 'Frame ordinals are contiguous from 0 (oldest)');
    if (snapshots.has(frame.snapshotId)) sink.add('DUPLICATE_ID', `frames[${i}]`, 'Duplicate frame snapshot');
    snapshots.add(frame.snapshotId);
    if (frame.graphChunk.path !== `graphs/${frame.snapshotId}.json.gz` || !listed(frame.graphChunk.path, frame.graphChunk.sha256)) {
      sink.add('CHUNK_REF', `frames[${i}].graphChunk`, 'Graph chunk path must match its snapshot and be listed');
    }
  });
  if (manifest.chunks.length !== manifest.frames.length + 2) sink.add('CHUNK_REF', 'chunks', 'Unreferenced chunks are not allowed');
  const head = manifest.frames.at(-1);
  if (head && head.commit.oid !== manifest.selectedCommit.oid) sink.add('HEAD_FRAME', 'frames', 'The newest frame must be the selected commit');
  const oidLength = manifest.repo.objectFormat === 'sha256' ? 64 : 40;
  if (manifest.selectedCommit.oid.length !== oidLength) sink.add('OBJECT_FORMAT', 'selectedCommit', 'Commit OID does not match object format');
  if (manifest.coverage.history.newestOid !== manifest.selectedCommit.oid) sink.add('COVERAGE', 'coverage.history', 'newestOid must be the selected commit');
  if (manifest.expiresAt !== null && manifest.expiresAt <= manifest.createdAt) sink.add('TIME', 'expiresAt', 'expiresAt must follow createdAt');
  return sink.issues.length === 0 ? { ok: true, value: manifest } : { ok: false, issues: sink.issues };
}
