import {
  CYCLE_EDGE_KINDS,
  DEGREE_EDGE_KINDS,
  FILE_EDGE_KINDS,
  LIMITS,
  compareAscii,
  compareUtf8,
  type Diagnostic,
  type EdgeKind,
  type FileNode,
  type GraphEdge,
  type GraphNode,
  type GraphSnapshot,
  type ImportObservation,
  type NodeMetrics,
  type PackageNode,
} from '@atlas/schema';

/**
 * Read-only query index over one validated snapshot, shared by the CLI and the browser
 * (plan §13.1: graph queries run client-side over validated chunks). All results are
 * returned in deterministic order.
 */
export type EdgePolicy = readonly EdgeKind[];

export const POLICIES = {
  /** Fan-in/fan-out policy (plan §10.1). */
  degree: DEGREE_EDGE_KINDS as EdgePolicy,
  /** Static cycle policy (plan §10.1). */
  cycle: CYCLE_EDGE_KINDS as EdgePolicy,
  /** Every file-level import relationship, including type-only and resources. */
  all: FILE_EDGE_KINDS as EdgePolicy,
} as const;

export interface ReachOptions {
  direction: 'outgoing' | 'incoming';
  depth?: number;
  maxVisited?: number;
  policy?: EdgePolicy;
}

export interface ReachResult {
  /** Reached file nodes with their BFS depth (start excluded), ordered by depth then path. */
  nodes: { id: string; depth: number }[];
  depth: number;
  /** The visit cap stopped the search. */
  truncated: boolean;
  /** Unvisited files exist one step past the depth limit. */
  beyondDepth: boolean;
}

export interface PackageRollup {
  sourcePackageId: string;
  targetPackageId: string;
  uniqueFilePairs: number;
  observations: number;
  kinds: EdgeKind[];
}

/** Derived indexes transferred only by ATLAS's validating worker, never artifact input. */
export interface GraphIndexData {
  nodes: Map<string, GraphNode>;
  children: Map<string, GraphNode[]>;
  filesByPath: Map<string, FileNode>;
  observations: Map<string, ImportObservation>;
  metrics: Map<string, NodeMetrics>;
  out: Map<string, GraphEdge[]>;
  in: Map<string, GraphEdge[]>;
  observationsBySource: Map<string, ImportObservation[]>;
  diagnosticsBySubject: Map<string, Diagnostic[]>;
}

export class GraphIndex {
  readonly nodes = new Map<string, GraphNode>();
  readonly children = new Map<string, GraphNode[]>();
  readonly filesByPath = new Map<string, FileNode>();
  readonly observations = new Map<string, ImportObservation>();
  readonly metrics = new Map<string, NodeMetrics>();
  private readonly out = new Map<string, GraphEdge[]>();
  private readonly in = new Map<string, GraphEdge[]>();
  private readonly observationsBySource = new Map<string, ImportObservation[]>();
  private readonly diagnosticsBySubject = new Map<string, Diagnostic[]>();
  private readonly packageCache = new Map<string, PackageNode | null>();

  constructor(readonly snapshot: GraphSnapshot, prepared?: GraphIndexData) {
    if (prepared) {
      this.nodes = prepared.nodes;
      this.children = prepared.children;
      this.filesByPath = prepared.filesByPath;
      this.observations = prepared.observations;
      this.metrics = prepared.metrics;
      this.out = prepared.out;
      this.in = prepared.in;
      this.observationsBySource = prepared.observationsBySource;
      this.diagnosticsBySubject = prepared.diagnosticsBySubject;
      return;
    }
    for (const node of snapshot.nodes) {
      this.nodes.set(node.id, node);
      if (node.kind === 'file') this.filesByPath.set(node.path, node);
      if (node.parentId) {
        const list = this.children.get(node.parentId) ?? [];
        list.push(node);
        this.children.set(node.parentId, list);
      }
    }
    for (const list of this.children.values()) list.sort((a, b) => compareUtf8(sortKey(a), sortKey(b)));
    for (const edge of snapshot.edges) {
      push(this.out, edge.sourceId, edge);
      push(this.in, edge.targetId, edge);
    }
    for (const obs of snapshot.importObservations) {
      this.observations.set(obs.id, obs);
      push(this.observationsBySource, obs.sourceId, obs);
    }
    for (const list of this.observationsBySource.values()) list.sort((a, b) => a.range.startOffset - b.range.startOffset || compareAscii(a.kind, b.kind));
    for (const diagnostic of snapshot.diagnostics) for (const subject of diagnostic.subjectIds) push(this.diagnosticsBySubject, subject, diagnostic);
    for (const metric of snapshot.metrics) this.metrics.set(metric.nodeId, metric);
  }

  transferData(): GraphIndexData {
    return { nodes: this.nodes, children: this.children, filesByPath: this.filesByPath, observations: this.observations, metrics: this.metrics,
      out: this.out, in: this.in, observationsBySource: this.observationsBySource, diagnosticsBySubject: this.diagnosticsBySubject };
  }

  get root(): GraphNode {
    return this.snapshot.nodes.find((n) => n.kind === 'repository')!;
  }

  outgoing(id: string, policy: EdgePolicy = POLICIES.all): GraphEdge[] {
    return (this.out.get(id) ?? []).filter((e) => policy.includes(e.kind));
  }

  incoming(id: string, policy: EdgePolicy = POLICIES.all): GraphEdge[] {
    return (this.in.get(id) ?? []).filter((e) => policy.includes(e.kind));
  }

  /** Statement-level evidence from a file, in source order (includes unresolved ones). */
  observationsFrom(fileId: string): ImportObservation[] {
    return this.observationsBySource.get(fileId) ?? [];
  }

  diagnosticsFor(id: string): Diagnostic[] {
    return this.diagnosticsBySubject.get(id) ?? [];
  }

  /** Unique included file targets/sources under a policy (plan §10.1 fan-out/fan-in). */
  fileNeighbors(id: string, direction: 'outgoing' | 'incoming', policy: EdgePolicy = POLICIES.degree): string[] {
    const edges = direction === 'outgoing' ? this.outgoing(id, policy) : this.incoming(id, policy);
    const ids = new Set<string>();
    for (const edge of edges) {
      const other = direction === 'outgoing' ? edge.targetId : edge.sourceId;
      if (this.nodes.get(other)?.kind === 'file') ids.add(other);
    }
    return [...ids].sort((a, b) => compareUtf8(this.pathOf(a), this.pathOf(b)));
  }

  pathOf(id: string): string {
    const node = this.nodes.get(id);
    if (!node) return '';
    return node.kind === 'file' || node.kind === 'directory' || node.kind === 'package' ? node.path : node.label;
  }

  /** The package that owns a node (packages own themselves). */
  packageOf(id: string): PackageNode | null {
    const cached = this.packageCache.get(id);
    if (cached !== undefined) return cached;
    let current = this.nodes.get(id);
    while (current && current.kind !== 'package') current = current.parentId ? this.nodes.get(current.parentId) : undefined;
    const result = current?.kind === 'package' ? current : null;
    this.packageCache.set(id, result);
    return result;
  }

  /** Ancestors from the repository down to (excluding) the node: for breadcrumbs. */
  ancestors(id: string): GraphNode[] {
    const chain: GraphNode[] = [];
    let current = this.nodes.get(id);
    while (current?.parentId) {
      current = this.nodes.get(current.parentId);
      if (current) chain.unshift(current);
    }
    return chain;
  }

  /** Bounded breadth-first reach (plan §12.2): default depth 2, max 5, at most 2,000 nodes. */
  reach(startId: string, options: ReachOptions): ReachResult {
    const depthLimit = Math.min(LIMITS.reachMaxDepth, Math.max(1, options.depth ?? LIMITS.reachDefaultDepth));
    const maxVisited = Math.min(LIMITS.reachMaxVisited, options.maxVisited ?? LIMITS.reachMaxVisited);
    const policy = options.policy ?? POLICIES.degree;
    const seen = new Map<string, number>([[startId, 0]]);
    let frontier = [startId];
    let truncated = false;
    for (let depth = 1; depth <= depthLimit && frontier.length > 0 && !truncated; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbor of this.fileNeighbors(id, options.direction, policy)) {
          if (seen.has(neighbor)) continue;
          if (seen.size - 1 >= maxVisited) {
            truncated = true;
            break;
          }
          seen.set(neighbor, depth);
          next.push(neighbor);
        }
        if (truncated) break;
      }
      frontier = next;
    }
    // Distinct from truncation: the depth limit stopped expansion with nodes still unreached.
    const beyondDepth = !truncated && frontier.some((id) => this.fileNeighbors(id, options.direction, policy).some((n) => !seen.has(n)));
    const nodes = [...seen].filter(([id]) => id !== startId).map(([id, depth]) => ({ id, depth }));
    nodes.sort((a, b) => a.depth - b.depth || compareUtf8(this.pathOf(a.id), this.pathOf(b.id)));
    return { nodes, depth: depthLimit, truncated, beyondDepth };
  }

  /** File edges rolled up to package pairs (plan §6.3): unique file pairs and observations. */
  packageRollups(policy: EdgePolicy = POLICIES.all): PackageRollup[] {
    const rollups = new Map<string, { s: string; t: string; pairs: Set<string>; observations: number; kinds: Set<EdgeKind> }>();
    for (const edge of this.snapshot.edges) {
      if (!policy.includes(edge.kind)) continue;
      const source = this.nodes.get(edge.sourceId);
      const target = this.nodes.get(edge.targetId);
      if (source?.kind !== 'file' || target?.kind !== 'file') continue;
      const s = this.packageOf(source.id)!.id;
      const t = this.packageOf(target.id)!.id;
      const key = `${s}|${t}`;
      let rollup = rollups.get(key);
      if (!rollup) {
        rollup = { s, t, pairs: new Set(), observations: 0, kinds: new Set() };
        rollups.set(key, rollup);
      }
      rollup.pairs.add(`${source.id}|${target.id}`);
      rollup.observations += edge.observationCount;
      rollup.kinds.add(edge.kind);
    }
    return [...rollups.values()]
      .map((r) => ({ sourcePackageId: r.s, targetPackageId: r.t, uniqueFilePairs: r.pairs.size, observations: r.observations, kinds: [...r.kinds].sort() }))
      .sort((a, b) => compareAscii(a.sourcePackageId, b.sourcePackageId) || compareAscii(a.targetPackageId, b.targetPackageId));
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function sortKey(node: GraphNode): string {
  // Containers before files, then by name, so trees read like a file explorer.
  const rank = node.kind === 'package' ? '0' : node.kind === 'directory' ? '1' : '2';
  return `${rank}${node.label}`;
}
