import { compareAscii, makeId, type GraphSnapshot } from '@atlas/schema';
import { POLICIES, type EdgePolicy } from './graph-index.js';

/**
 * Static cycles (plan §10.2): deterministic Tarjan over file nodes under a declared edge
 * policy, O(V+E), iterative so deep chains cannot overflow the call stack. A component is
 * a cycle when it has more than one file or a self-edge. Each carries a bounded witness:
 * the shortest cycle through its first member (by node ID), found by breadth-first search.
 */
export interface StaticCycle {
  sccId: string;
  /** Member file node IDs, sorted. */
  members: string[];
  /** A concrete cycle `a -> b -> … -> a` (first element repeated at the end). */
  witness: string[];
  selfEdge: boolean;
}

export const MAX_WITNESS_LENGTH = 64;

export function findStaticCycles(snapshot: GraphSnapshot, policy: EdgePolicy = POLICIES.cycle): StaticCycle[] {
  const files = snapshot.nodes.filter((n) => n.kind === 'file').map((n) => n.id).sort(compareAscii);
  const lineage = new Map(snapshot.nodes.map((n) => [n.id, n.lineageId]));
  const fileSet = new Set(files);
  const adjacency = new Map<string, string[]>();
  const selfEdges = new Set<string>();
  for (const edge of snapshot.edges) {
    if (!policy.includes(edge.kind) || !fileSet.has(edge.sourceId) || !fileSet.has(edge.targetId)) continue;
    if (edge.sourceId === edge.targetId) selfEdges.add(edge.sourceId);
    const list = adjacency.get(edge.sourceId) ?? [];
    if (!list.includes(edge.targetId)) list.push(edge.targetId);
    adjacency.set(edge.sourceId, list);
  }
  for (const list of adjacency.values()) list.sort(compareAscii);

  // Iterative Tarjan.
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const start of files) {
    if (index.has(start)) continue;
    const work: { node: string; next: number }[] = [{ node: start, next: 0 }];
    index.set(start, counter);
    low.set(start, counter++);
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbors = adjacency.get(frame.node) ?? [];
      if (frame.next < neighbors.length) {
        const target = neighbors[frame.next++]!;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter++);
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }

  const cycles: StaticCycle[] = [];
  for (const component of components) {
    const members = component.sort(compareAscii);
    const selfEdge = members.length === 1 && selfEdges.has(members[0]!);
    if (members.length < 2 && !selfEdge) continue;
    const identity = members.map((m) => lineage.get(m) ?? m).sort(compareAscii);
    cycles.push({ sccId: makeId('scc', [snapshot.snapshotId, ...identity]), members, witness: witness(members, adjacency), selfEdge });
  }
  return cycles.sort((a, b) => compareAscii(a.members[0]!, b.members[0]!));
}

/** Shortest cycle through the component's first member, restricted to the component. */
function witness(members: string[], adjacency: Map<string, string[]>): string[] {
  const start = members[0]!;
  const inComponent = new Set(members);
  const previous = new Map<string, string>();
  const queue = [start];
  const visited = new Set([start]);
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      if (!inComponent.has(next)) continue;
      if (next === start) {
        const path = [node];
        for (let p = previous.get(node); p !== undefined; p = previous.get(p)) path.unshift(p);
        if (path[0] !== start) path.unshift(start);
        return [...path, start].slice(-(MAX_WITNESS_LENGTH + 1));
      }
      if (visited.has(next)) continue;
      visited.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return [start, start];
}
