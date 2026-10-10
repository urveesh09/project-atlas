import { GraphIndex, type GraphIndexData } from '@atlas/graph';
import { prepareCity, type CityData } from '@atlas/layout';
import {
  RULE_CATALOG,
  compareAscii,
  compareUtf8,
  type ArtifactBundle,
  type Diagnostic,
  type FileNode,
  type GraphNode,
  type RuleId,
} from '@atlas/schema';

/**
 * Immutable dataset state (plan §12.1): the validated bundle and indexes derived from the
 * active frame. View state lives separately and refers to nodes by ID.
 */
export class ViewerModel {
  readonly graph;
  readonly index: GraphIndex;
  readonly city: CityData;
  readonly fileByLineage = new Map<string, FileNode>();
  readonly diagnostics: Diagnostic[];
  readonly sourceSnapshotId: string;

  private queryWorker: Worker | undefined;
  constructor(
    readonly bundle: ArtifactBundle,
    prepared?: GraphIndexData,
    city?: CityData,
    queryWorker?: Worker,
  ) {
    this.queryWorker = queryWorker;
    this.graph = bundle.graphs.at(-1)!;
    this.sourceSnapshotId = this.graph.snapshotId;
    this.index = new GraphIndex(this.graph, prepared);
    this.city = city ?? prepareCity(this.graph, bundle.layout);
    for (const node of this.graph.nodes)
      if (node.kind === 'file' && node.lineageId) this.fileByLineage.set(node.lineageId, node);
    const rank = { error: 0, warning: 1, info: 2 } as const;
    this.diagnostics = [...this.graph.diagnostics].sort(
      (a, b) =>
        rank[a.severity] - rank[b.severity] ||
        compareAscii(a.ruleId, b.ruleId) ||
        compareUtf8(this.pathOf(a.subjectIds[0]!), this.pathOf(b.subjectIds[0]!)),
    );
  }

  get manifest() {
    return this.bundle.manifest;
  }

  /** One owner only; a development StrictMode remount builds a fresh standalone worker. */
  takeQueryWorker(): Worker | undefined {
    const worker = this.queryWorker;
    this.queryWorker = undefined;
    return worker;
  }

  node(id: string | null | undefined): GraphNode | undefined {
    return id ? this.index.nodes.get(id) : undefined;
  }

  pathOf(id: string): string {
    return this.index.pathOf(id);
  }

  /** Human label for any node: package names, paths, or perimeter names. */
  title(node: GraphNode): string {
    switch (node.kind) {
      case 'repository':
        return node.label;
      case 'package':
        return node.packageName ?? (node.path === '' ? `${node.label} (root)` : node.path);
      case 'external-package':
        return node.packageName;
      case 'builtin':
        return node.label;
      default:
        return node.path;
    }
  }

  ruleTitle(diagnostic: Diagnostic): string {
    return RULE_CATALOG[diagnostic.ruleId as RuleId]?.title ?? diagnostic.ruleId;
  }

  /** Files with at least one diagnostic, for tree badges. */
  diagnosticCount(id: string): number {
    return this.index.diagnosticsFor(id).length;
  }
}

export const ROLE_LABEL: Record<string, string> = {
  source: 'Source',
  test: 'Test',
  config: 'Config',
  declaration: 'Declaration',
  asset: 'Asset',
  opaque: 'Other',
};

export function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}
