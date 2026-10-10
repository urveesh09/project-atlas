import { GraphIndex, hotspotBaseline, hotspotFactors, type HotspotBaseline } from '@atlas/graph';
import { churnAvailability, type FrameChurn } from '@atlas/history';
import { LIMITS, compareAscii, type Availability, type GraphSnapshot, type NodeMetrics } from '@atlas/schema';
import { evaluateChangeConcentration } from './rules.js';

/**
 * History metrics for one frame (plan §7.5, §10.1, §10.3).
 *
 * Files: `changedCommits` counts window commits up to this frame that changed the file's
 * lineage, once per commit; `linesAdded`/`linesDeleted` sum the known numstat lines of
 * those changes. Unknown line counts (binary, path-only diffs, split ambiguous renames)
 * or an unavailable oldest change make history `partial`; when every contributing change
 * lacks line counts the line totals are null rather than a misleading zero.
 *
 * Containers: `changedCommits` is the number of distinct commits that changed any file
 * currently in the container; line totals are sums over those files. A container metric
 * describes current members, so a file moved out takes its history with it.
 */
export function applyHistoryMetrics(graph: GraphSnapshot, churn: FrameChurn): GraphSnapshot {
  const index = new GraphIndex(graph);
  const fileHistory = new Map<string, { metric: Pick<NodeMetrics, 'changedCommits' | 'linesAdded' | 'linesDeleted'>; availability: Availability; commits: readonly number[] }>();
  for (const node of graph.nodes) {
    if (node.kind !== 'file' || node.lineageId === null) continue;
    const c = churn.byLineage.get(node.lineageId);
    const availability = churnAvailability(churn, c);
    const changed = c?.changedCommits ?? 0;
    // No text line data at all (only binary or unknown contributions): null, never zero.
    const allLinesUnknown = c !== undefined && c.linesKnown === 0 && c.linesUnknown + c.linesNotApplicable > 0;
    fileHistory.set(node.id, {
      metric: { changedCommits: changed, linesAdded: allLinesUnknown ? null : (c?.linesAdded ?? 0), linesDeleted: allLinesUnknown ? null : (c?.linesDeleted ?? 0) },
      availability,
      commits: churn.commitsByLineage.get(node.lineageId) ?? [],
    });
  }
  const containerMembers = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== 'file' || !fileHistory.has(node.id)) continue;
    for (const ancestor of index.ancestors(node.id)) {
      const list = containerMembers.get(ancestor.id) ?? [];
      list.push(node.id);
      containerMembers.set(ancestor.id, list);
    }
  }
  const metrics = graph.metrics.map((m): NodeMetrics => {
    const file = fileHistory.get(m.nodeId);
    if (file) return { ...m, ...file.metric, availability: { ...m.availability, history: file.availability } };
    const node = index.nodes.get(m.nodeId);
    if (!node || (node.kind !== 'repository' && node.kind !== 'package' && node.kind !== 'directory')) return m;
    const members = (containerMembers.get(m.nodeId) ?? []).map((id) => fileHistory.get(id)!);
    const commits = new Set<number>();
    let added: number | null = 0;
    let deleted: number | null = 0;
    let complete = !churn.windowIncomplete;
    for (const member of members) {
      for (const position of member.commits) commits.add(position);
      if (member.availability !== 'complete') complete = false;
      added = member.metric.linesAdded === null || added === null ? added : added + member.metric.linesAdded;
      deleted = member.metric.linesDeleted === null || deleted === null ? deleted : deleted + member.metric.linesDeleted;
    }
    return { ...m, changedCommits: commits.size, linesAdded: added, linesDeleted: deleted, availability: { ...m.availability, history: complete ? 'complete' : 'partial' } };
  });
  return { ...graph, metrics };
}

/**
 * Store hotspot scores (files only) against the fixed HEAD baseline, then add
 * change-concentration findings for this frame. Containers never receive a score.
 */
export function applyHotspotsAndHistoryFindings(graph: GraphSnapshot, baseline: HotspotBaseline, windowCommits: number): { graph: GraphSnapshot; omittedDiagnostics: number } {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const metrics = graph.metrics.map((m): NodeMetrics => {
    const node = nodes.get(m.nodeId);
    if (node?.kind !== 'file') return m;
    const factors = hotspotFactors(baseline, node, m);
    return { ...m, hotspotScore: factors?.score ?? null };
  });
  const scored: GraphSnapshot = { ...graph, metrics };
  const findings = evaluateChangeConcentration(scored, windowCommits);
  const all = [...graph.diagnostics, ...findings].sort((a, b) => compareAscii(a.id, b.id));
  const diagnostics = all.slice(0, LIMITS.diagnosticsPerFrame);
  return { graph: { ...scored, diagnostics }, omittedDiagnostics: all.length - diagnostics.length };
}

export { hotspotBaseline };
