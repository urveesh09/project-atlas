import type { SyntaxFacts as FileFacts } from './facts.js';
import { GraphIndex, type StaticCycle } from '@atlas/graph';
import { compareAscii, type Availability, type GraphNode, type GraphSnapshot, type NodeMetrics } from '@atlas/schema';

/**
 * Node metrics (plan §10.1), with null meaning "not available", never zero.
 *
 * Files: lines from facts; complexity for parsed non-declaration code; fan-in/fan-out as
 * unique included files under the default value-edge policy; SCC membership.
 * Containers: explicit sums (lines, declarations, callables, sumCyclomatic) and the
 * maximum of maxCyclomatic over descendant files; fan-in/fan-out are not defined for
 * containers and stay null. History metrics stay null until history exists (P4).
 */
export function computeMetrics(snapshot: GraphSnapshot, facts: Map<string, FileFacts>, cycles: readonly StaticCycle[]): NodeMetrics[] {
  const index = new GraphIndex(snapshot);
  // Dropped relationships can affect degrees and SCC membership beyond their
  // endpoints. Observed counts remain useful, but never claim complete coverage.
  const edgesComplete = !snapshot.coverage.limitsHit.includes('EDGE_LIMIT');
  const sccOf = new Map<string, string>();
  for (const cycle of cycles) for (const member of cycle.members) sccOf.set(member, cycle.sccId);
  const fileMetrics = new Map<string, NodeMetrics>();

  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') continue;
    const f = facts.get(node.path);
    const parsed = f?.parseStatus === 'parsed';
    const executable = parsed && node.role !== 'declaration';
    const syntax: Availability = parsed ? 'complete' : f ? 'partial' : 'unavailable';
    fileMetrics.set(node.id, {
      nodeId: node.id,
      physicalLines: f ? f.physicalLines : null,
      codeLines: parsed ? f.codeLines : null,
      declarationCount: parsed ? f.declarations.length + f.declarationsOmitted : null,
      maxCyclomatic: executable ? f.complexity!.maxCyclomatic : null,
      sumCyclomatic: executable ? f.complexity!.sumCyclomatic : null,
      callableCount: executable ? f.complexity!.callableCount : null,
      fanIn: index.fileNeighbors(node.id, 'incoming').length,
      // Only a parsed file's own imports are known.
      fanOut: parsed ? index.fileNeighbors(node.id, 'outgoing').length : null,
      sccId: sccOf.get(node.id) ?? null,
      changedCommits: null,
      linesAdded: null,
      linesDeleted: null,
      hotspotScore: null,
      availability: { syntax, dependencies: parsed && edgesComplete ? 'complete' : 'partial', history: 'unavailable' },
    });
  }

  // Containers aggregate their descendant files.
  const containerMetrics: NodeMetrics[] = [];
  const descendants = new Map<string, NodeMetrics[]>();
  for (const node of snapshot.nodes) {
    if (node.kind !== 'file') continue;
    const metric = fileMetrics.get(node.id)!;
    for (const ancestor of index.ancestors(node.id)) {
      const list = descendants.get(ancestor.id) ?? [];
      list.push(metric);
      descendants.set(ancestor.id, list);
    }
  }
  const sum = (values: (number | null)[]) => (values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null);
  const max = (values: (number | null)[]) => (values.some((v) => v !== null) ? Math.max(...values.filter((v): v is number => v !== null)) : null);
  for (const node of snapshot.nodes) {
    if (!isContainer(node)) continue;
    const list = descendants.get(node.id) ?? [];
    const withSyntax = list.filter((m) => m.availability.syntax === 'complete').length;
    containerMetrics.push({
      nodeId: node.id,
      physicalLines: sum(list.map((m) => m.physicalLines)),
      codeLines: sum(list.map((m) => m.codeLines)),
      declarationCount: sum(list.map((m) => m.declarationCount)),
      maxCyclomatic: max(list.map((m) => m.maxCyclomatic)),
      sumCyclomatic: sum(list.map((m) => m.sumCyclomatic)),
      callableCount: sum(list.map((m) => m.callableCount)),
      fanIn: null,
      fanOut: null,
      sccId: null,
      changedCommits: null,
      linesAdded: null,
      linesDeleted: null,
      hotspotScore: null,
      availability: {
        syntax: withSyntax === 0 ? 'unavailable' : withSyntax === list.length ? 'complete' : 'partial',
        dependencies: 'unavailable',
        history: 'unavailable',
      },
    });
  }
  return [...fileMetrics.values(), ...containerMetrics].sort((a, b) => compareAscii(a.nodeId, b.nodeId));
}

function isContainer(node: GraphNode): boolean {
  return node.kind === 'repository' || node.kind === 'package' || node.kind === 'directory';
}
