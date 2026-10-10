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

export interface UnvalidatedBundle {
  manifest: unknown;
  graphs: unknown[];
  history: unknown;
  layout: unknown;
}

const prefix = (scope: string, issues: readonly ValidationIssue[]) => issues.map((i) => ({ ...i, path: `${scope}:${i.path}` }));

/**
 * Validate every chunk, then the references between them (plan §6.5, §11.2): frames,
 * snapshots, commits and counts agree; every file occurrence has exactly one lineage,
 * one plot and one frame-state entry; containers map to existing districts.
 */
export function validateArtifactBundle(input: UnvalidatedBundle): ValidationResult<ArtifactBundle> {
  const issues: ValidationIssue[] = [];
  const manifestResult = validateManifest(input.manifest);
  if (!manifestResult.ok) return { ok: false, issues: prefix('manifest', manifestResult.issues) };
  const manifest = manifestResult.value;
  const objectFormat = manifest.repo.objectFormat;

  const graphs: GraphSnapshot[] = [];
  input.graphs.forEach((graph, i) => {
    const result = validateGraphSnapshot(graph, { objectFormat });
    if (result.ok) graphs.push(result.value);
    else issues.push(...prefix(`graph[${i}]`, result.issues));
  });
  const historyResult = validateHistoryArtifact(input.history);
  if (!historyResult.ok) issues.push(...prefix('history', historyResult.issues));
  const layoutResult = validateLayoutArtifact(input.layout);
  if (!layoutResult.ok) issues.push(...prefix('layout', layoutResult.issues));
  if (issues.length > 0 || !historyResult.ok || !layoutResult.ok) return { ok: false, issues };
  const history = historyResult.value;
  const layout = layoutResult.value;
  const add = (code: string, path: string, message: string) => {
    if (issues.length < 200) issues.push({ code, path, message });
  };

  if (graphs.length !== manifest.frames.length) add('FRAME_COUNT', 'graphs', 'One graph per manifest frame is required');
  manifest.frames.forEach((frame, i) => {
    const graph = graphs[i];
    if (!graph) return;
    const at = `frames[${i}]`;
    if (graph.snapshotId !== frame.snapshotId) add('FRAME_MISMATCH', at, 'Graph snapshot does not match its frame');
    if (graph.repoId !== manifest.repo.repoId) add('FRAME_MISMATCH', at, 'Graph belongs to a different repository');
    if (graph.commitOid !== frame.commit.oid) add('FRAME_MISMATCH', at, 'Graph commit does not match its frame');
    if (graph.nodes.length !== frame.nodeCount || graph.edges.length !== frame.edgeCount) add('FRAME_MISMATCH', at, 'Frame node/edge counts disagree with the graph');
    if (canonicalJson(graph.coverage) !== canonicalJson(frame.coverage)) add('FRAME_MISMATCH', at, 'Frame coverage disagrees with the graph');
  });
  const head = graphs.at(-1);
  if (head && canonicalJson(head.coverage) !== canonicalJson(manifest.coverage.head)) add('COVERAGE', 'coverage.head', 'Head coverage must equal the selected frame coverage');

  // History frames mirror manifest frames.
  if (history.frames.length !== manifest.frames.length) add('HISTORY_FRAMES', 'history.frames', 'History frames must mirror manifest frames');
  history.frames.forEach((frame, i) => {
    const expected = manifest.frames[i];
    if (expected && (frame.snapshotId !== expected.snapshotId || frame.commitOid !== expected.commit.oid)) add('HISTORY_FRAMES', `history.frames[${i}]`, 'History frame does not match manifest frame');
  });

  // Every file occurrence: one lineage occurrence, one plot, one frame-state entry.
  const lineageOf = new Map<string, string>();
  for (const lineage of history.lineages) {
    for (const occurrence of lineage.occurrences) lineageOf.set(`${occurrence.snapshotId}|${occurrence.nodeId}`, lineage.id);
  }
  const plots = new Set(layout.plots.map((p) => p.lineageId));
  const districts = new Set(layout.districts.map((d) => d.id));
  if (layout.frameState.length !== graphs.length) add('LAYOUT_FRAMES', 'layout.frameState', 'One frame state per graph is required');
  graphs.forEach((graph, i) => {
    const state = layout.frameState[i];
    if (!state || state.snapshotId !== graph.snapshotId) {
      add('LAYOUT_FRAMES', `layout.frameState[${i}]`, 'Frame state does not match its graph');
      return;
    }
    const files = new Map(state.files.map((f) => [f.nodeId, f]));
    const containers = new Set(state.containers.map((c) => c.graphNodeId));
    for (const node of graph.nodes) {
      if (node.kind === 'file') {
        const lineage = lineageOf.get(`${graph.snapshotId}|${node.id}`);
        if (!lineage || lineage !== node.lineageId) add('LINEAGE', node.id, 'File occurrence is missing from its lineage');
        if (node.lineageId && !plots.has(node.lineageId)) add('PLOT', node.id, 'File lineage has no plot');
        const entry = files.get(node.id);
        if (!entry || entry.lineageId !== node.lineageId || entry.currentParentId !== node.parentId) add('FRAME_STATE', node.id, 'File frame state is missing or inconsistent');
      } else if ((node.kind === 'repository' || node.kind === 'package' || node.kind === 'directory') && !containers.has(node.id)) {
        add('FRAME_STATE', node.id, 'Container has no district mapping');
      }
    }
    if (files.size !== graph.nodes.filter((n) => n.kind === 'file').length) add('FRAME_STATE', `layout.frameState[${i}]`, 'Frame state lists files that are not in the graph');
    for (const container of state.containers) {
      if (container.layoutDistrictId !== null && !districts.has(container.layoutDistrictId)) add('FRAME_STATE', container.graphNodeId, 'Unknown district');
    }
  });

  return issues.length === 0 ? { ok: true, value: { manifest, graphs, history, layout } } : { ok: false, issues };
}
