import type { ArtifactManifest } from './artifact.js';
import { canonicalJson } from './canonical.js';
import type { GraphSnapshot } from './graph.js';
import type { HistoryArtifact } from './history.js';
import {
  validateGraphSnapshot,
  validateHistoryArtifact,
  validateLayoutArtifact,
  validateManifest,
  type ValidationIssue,
  type ValidationResult,
} from './invariants.js';
import type { LayoutArtifact } from './layout.js';

/** A fully decoded artifact: manifest plus every chunk it references. */
export interface ArtifactBundle {
  manifest: ArtifactManifest;
  /** Graph snapshots in manifest frame order. */
  graphs: GraphSnapshot[];
  history: HistoryArtifact;
  layout: LayoutArtifact;
}

/** Everything except the frame graphs: what a viewer validates before the first frame. */
export interface ArtifactCore {
  manifest: ArtifactManifest;
  history: HistoryArtifact;
  layout: LayoutArtifact;
}

export interface UnvalidatedBundle {
  manifest: unknown;
  graphs: unknown[];
  history: unknown;
  layout: unknown;
}

const prefix = (scope: string, issues: readonly ValidationIssue[]) =>
  issues.map((i) => ({ ...i, path: `${scope}:${i.path}` }));

class Issues {
  readonly list: ValidationIssue[] = [];
  add(code: string, path: string, message: string): void {
    if (this.list.length < 200) this.list.push({ code, path, message });
  }
}

/**
 * Validate manifest, history and layout and the references among them (plan §6.5,
 * §7.2, §11.2), without any graph: frames mirror each other and follow the first-parent
 * chain oldest to newest; the frame selection agrees with the analyzed frames; lineage
 * occurrences name analyzed frames at most once each, in frame order.
 */
export function validateArtifactCore(input: { manifest: unknown; history: unknown; layout: unknown }): ValidationResult<ArtifactCore> {
  const manifestResult = validateManifest(input.manifest);
  if (!manifestResult.ok) return { ok: false, issues: prefix('manifest', manifestResult.issues) };
  const manifest = manifestResult.value;
  const issues = new Issues();
  const historyResult = validateHistoryArtifact(input.history);
  if (!historyResult.ok) issues.list.push(...prefix('history', historyResult.issues));
  const layoutResult = validateLayoutArtifact(input.layout);
  if (!layoutResult.ok) issues.list.push(...prefix('layout', layoutResult.issues));
  if (!historyResult.ok || !layoutResult.ok) return { ok: false, issues: issues.list };
  const history = historyResult.value;
  const layout = layoutResult.value;

  // History frames mirror manifest frames.
  if (history.frames.length !== manifest.frames.length)
    issues.add('HISTORY_FRAMES', 'history.frames', 'History frames must mirror manifest frames');
  history.frames.forEach((frame, i) => {
    const expected = manifest.frames[i];
    if (expected && (frame.snapshotId !== expected.snapshotId || frame.commitOid !== expected.commit.oid))
      issues.add('HISTORY_FRAMES', `history.frames[${i}]`, 'History frame does not match manifest frame');
  });

  // With a history window, frames are window commits in oldest-to-newest chain order.
  if (history.commits.length > 0) {
    const position = new Map(history.commits.map((c, i) => [c.oid, i]));
    if (history.commits[0]!.oid !== manifest.selectedCommit.oid)
      issues.add('HISTORY_CHAIN', 'history.commits', 'The history window starts at the selected commit');
    let previous = Number.POSITIVE_INFINITY;
    manifest.frames.forEach((frame, i) => {
      const at = position.get(frame.commit.oid);
      if (at === undefined) issues.add('HISTORY_CHAIN', `frames[${i}]`, 'Frame commit is outside the history window');
      else if (at >= previous) issues.add('HISTORY_CHAIN', `frames[${i}]`, 'Frames must follow the first-parent chain from oldest to newest');
      else previous = at;
    });
    const c = manifest.coverage.history;
    if (c.commitsTraversed !== history.commits.length)
      issues.add('COVERAGE', 'coverage.history.commitsTraversed', 'commitsTraversed must equal the history window');
    if (c.oldestOid !== history.commits.at(-1)!.oid) issues.add('COVERAGE', 'coverage.history.oldestOid', 'oldestOid must be the oldest window commit');
  }
  const selection = history.frameSelection;
  if (selection) {
    const analyzed = selection.commits.filter((c) => c.status === 'analyzed').map((c) => c.commitOid);
    if (canonicalJson(analyzed) !== canonicalJson(manifest.frames.map((f) => f.commit.oid)))
      issues.add('FRAME_SELECTION', 'history.frameSelection', 'Analyzed selected commits must be exactly the manifest frames');
    for (let i = 1; i < selection.commits.length; i++)
      if (selection.commits[i]!.chainIndex <= selection.commits[i - 1]!.chainIndex)
        issues.add('FRAME_SELECTION', `history.frameSelection.commits[${i}]`, 'Selected commits are in increasing chain order');
    for (const commit of selection.commits) {
      if (commit.chainIndex >= selection.windowCommits) issues.add('FRAME_SELECTION', commit.commitOid, 'Selected commit lies outside the window');
      if ((commit.status === 'unavailable') !== (commit.reason !== null)) issues.add('FRAME_SELECTION', commit.commitOid, 'Exactly the unavailable selections carry a reason');
    }
    const c = manifest.coverage.history;
    if (c.framesRequested !== selection.commits.length || c.framesCompleted !== analyzed.length)
      issues.add('COVERAGE', 'coverage.history', 'Frame counts must agree with the frame selection');
  }
  const frameOrdinal = new Map(manifest.frames.map((f, i) => [f.snapshotId, i]));
  for (const lineage of history.lineages) {
    let last = -1;
    for (const occurrence of lineage.occurrences) {
      const ordinal = frameOrdinal.get(occurrence.snapshotId);
      if (ordinal === undefined) issues.add('LINEAGE', lineage.id, 'Lineage occurrence names an unknown frame');
      else if (ordinal <= last) issues.add('LINEAGE', lineage.id, 'Lineage occurrences are unique per frame and in frame order');
      else last = ordinal;
    }
  }
  if (layout.frameState.length !== manifest.frames.length)
    issues.add('LAYOUT_FRAMES', 'layout.frameState', 'One frame state per frame is required');
  layout.frameState.forEach((state, i) => {
    if (state.snapshotId !== manifest.frames[i]?.snapshotId)
      issues.add('LAYOUT_FRAMES', `layout.frameState[${i}]`, 'Frame state does not match its frame');
  });
  return issues.list.length === 0 ? { ok: true, value: { manifest, history, layout } } : { ok: false, issues: issues.list };
}

/** Lookups shared by repeated per-frame validation. */
export class FrameValidationContext {
  readonly lineageOf = new Map<string, string>();
  readonly occurrencesBySnapshot = new Map<string, { lineageId: string; nodeId: string }[]>();
  readonly plots: Set<string>;
  readonly districts: Set<string>;
  constructor(readonly core: ArtifactCore) {
    for (const lineage of core.history.lineages)
      for (const occurrence of lineage.occurrences) {
        this.lineageOf.set(`${occurrence.snapshotId}|${occurrence.nodeId}`, lineage.id);
        const list = this.occurrencesBySnapshot.get(occurrence.snapshotId) ?? [];
        list.push({ lineageId: lineage.id, nodeId: occurrence.nodeId });
        this.occurrencesBySnapshot.set(occurrence.snapshotId, list);
      }
    this.plots = new Set(core.layout.plots.map((p) => p.lineageId));
    this.districts = new Set(core.layout.districts.map((d) => d.id));
  }
}

/**
 * Cross-check one decoded frame graph against the validated core: its frame descriptor,
 * one lineage occurrence, plot and frame-state entry per file, and a district mapping per
 * container. `validateGraphSnapshot` must already have passed for this graph.
 */
export function validateFrameAgainstCore(context: FrameValidationContext, index: number, graph: GraphSnapshot): ValidationIssue[] {
  const { manifest, layout } = context.core;
  const issues = new Issues();
  const frame = manifest.frames[index];
  const at = `frames[${index}]`;
  if (!frame) {
    issues.add('FRAME_COUNT', at, 'No such frame');
    return issues.list;
  }
  if (graph.snapshotId !== frame.snapshotId) issues.add('FRAME_MISMATCH', at, 'Graph snapshot does not match its frame');
  if (graph.repoId !== manifest.repo.repoId) issues.add('FRAME_MISMATCH', at, 'Graph belongs to a different repository');
  if (graph.commitOid !== frame.commit.oid) issues.add('FRAME_MISMATCH', at, 'Graph commit does not match its frame');
  if (graph.nodes.length !== frame.nodeCount || graph.edges.length !== frame.edgeCount)
    issues.add('FRAME_MISMATCH', at, 'Frame node/edge counts disagree with the graph');
  if (canonicalJson(graph.coverage) !== canonicalJson(frame.coverage)) issues.add('FRAME_MISMATCH', at, 'Frame coverage disagrees with the graph');
  if (index === manifest.frames.length - 1 && canonicalJson(graph.coverage) !== canonicalJson(manifest.coverage.head))
    issues.add('COVERAGE', 'coverage.head', 'Head coverage must equal the selected frame coverage');

  const state = layout.frameState[index];
  if (!state || state.snapshotId !== graph.snapshotId) {
    issues.add('LAYOUT_FRAMES', `layout.frameState[${index}]`, 'Frame state does not match its graph');
    return issues.list;
  }
  const files = new Map(state.files.map((f) => [f.nodeId, f]));
  const containers = new Set(state.containers.map((c) => c.graphNodeId));
  let fileCount = 0;
  for (const node of graph.nodes) {
    if (node.kind === 'file') {
      fileCount++;
      const lineage = context.lineageOf.get(`${graph.snapshotId}|${node.id}`);
      if (!lineage || lineage !== node.lineageId) issues.add('LINEAGE', node.id, 'File occurrence is missing from its lineage');
      if (node.lineageId && !context.plots.has(node.lineageId)) issues.add('PLOT', node.id, 'File lineage has no plot');
      const entry = files.get(node.id);
      if (!entry || entry.lineageId !== node.lineageId || entry.currentParentId !== node.parentId)
        issues.add('FRAME_STATE', node.id, 'File frame state is missing or inconsistent');
    } else if ((node.kind === 'repository' || node.kind === 'package' || node.kind === 'directory') && !containers.has(node.id)) {
      issues.add('FRAME_STATE', node.id, 'Container has no district mapping');
    }
  }
  if (files.size !== fileCount) issues.add('FRAME_STATE', `layout.frameState[${index}]`, 'Frame state lists files that are not in the graph');
  for (const container of state.containers)
    if (container.layoutDistrictId !== null && !context.districts.has(container.layoutDistrictId))
      issues.add('FRAME_STATE', container.graphNodeId, 'Unknown district');
  // Every lineage occurrence recorded for this frame names a file node of this graph.
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const occurrences = context.occurrencesBySnapshot.get(graph.snapshotId) ?? [];
  for (const o of occurrences) if (!nodeIds.has(o.nodeId)) issues.add('LINEAGE', o.lineageId, 'Lineage occurrence names a node absent from its frame');
  if (occurrences.length !== fileCount) issues.add('LINEAGE', at, 'Lineage occurrences and frame files disagree');
  return issues.list;
}

/**
 * Validate every chunk, then the references between them (plan §6.5, §11.2): frames,
 * snapshots, commits and counts agree; every file occurrence has exactly one lineage,
 * one plot and one frame-state entry; containers map to existing districts.
 */
export function validateArtifactBundle(
  input: UnvalidatedBundle,
  options: { graphIdVerification?: readonly boolean[] } = {},
): ValidationResult<ArtifactBundle> {
  const manifestResult = validateManifest(input.manifest);
  if (!manifestResult.ok) return { ok: false, issues: prefix('manifest', manifestResult.issues) };
  const objectFormat = manifestResult.value.repo.objectFormat;
  const issues: ValidationIssue[] = [];
  const graphs: GraphSnapshot[] = [];
  input.graphs.forEach((graph, i) => {
    const result = validateGraphSnapshot(graph, { objectFormat, verifyIds: options.graphIdVerification?.[i] ?? true });
    if (result.ok) graphs.push(result.value);
    else issues.push(...prefix(`graph[${i}]`, result.issues));
  });
  const core = validateArtifactCore(input);
  if (!core.ok) issues.push(...core.issues);
  if (issues.length > 0 || !core.ok) return { ok: false, issues };
  if (graphs.length !== core.value.manifest.frames.length)
    return { ok: false, issues: [{ code: 'FRAME_COUNT', path: 'graphs', message: 'One graph per manifest frame is required' }] };
  const context = new FrameValidationContext(core.value);
  graphs.forEach((graph, i) => issues.push(...validateFrameAgainstCore(context, i, graph)));
  return issues.length === 0 ? { ok: true, value: { ...core.value, graphs } } : { ok: false, issues: issues.slice(0, 200) };
}
