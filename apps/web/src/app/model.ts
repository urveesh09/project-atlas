import { GraphIndex, hotspotBaseline, type GraphIndexData, type HotspotBaseline } from '@atlas/graph';
import { prepareCity, type CityData } from '@atlas/layout';
import {
  RULE_CATALOG,
  compareAscii,
  compareUtf8,
  perimeterName,
  type ArtifactCore,
  type CoChangePair,
  type Diagnostic,
  type FileChange,
  type FileLineage,
  type FileNode,
  type GraphNode,
  type GraphSnapshot,
  type HistoryCommit,
  type LayoutPlot,
  type RuleId,
} from '@atlas/schema';

/**
 * Immutable dataset state (plan §12.1): one validated artifact's manifest, history and
 * layout, plus lookups that every frame shares. Frame graphs are decoded on demand and
 * become `ViewerModel`s; the dataset session owns the retained query worker.
 */
export class ViewerDataset {
  readonly manifest: ArtifactCore['manifest'];
  readonly history: ArtifactCore['history'];
  readonly layout: ArtifactCore['layout'];
  readonly headIndex: number;
  readonly lineages = new Map<string, FileLineage>();
  readonly frameOfSnapshot = new Map<string, number>();
  /** Position of each window commit counted from the oldest (0). */
  readonly chainIndex = new Map<string, number>();
  readonly changesByLineage = new Map<string, { commit: HistoryCommit; change: FileChange }[]>();
  readonly partners = new Map<string, CoChangePair[]>();
  /** The fixed HEAD cohort: one grading for every frame (plan §10.3). */
  readonly baseline: HotspotBaseline;
  /** The full hotspot score exists only with usable history; otherwise Structure attention. */
  readonly hotspotAvailable: boolean;
  /** The one fixed plot of each lineage (plan §11.3). */
  readonly plotOf = new Map<string, LayoutPlot>();
  private readonly heights = new Map<number, Map<string, number>>();
  private worker: Worker | undefined;

  constructor(core: ArtifactCore, head: GraphSnapshot, worker?: Worker) {
    this.manifest = core.manifest;
    this.history = core.history;
    this.layout = core.layout;
    this.worker = worker;
    this.headIndex = core.manifest.frames.length - 1;
    core.manifest.frames.forEach((f, i) => this.frameOfSnapshot.set(f.snapshotId, i));
    core.history.commits.forEach((c, i) => this.chainIndex.set(c.oid, core.history.commits.length - 1 - i));
    for (const lineage of core.history.lineages) this.lineages.set(lineage.id, lineage);
    for (const commit of core.history.commits)
      for (const change of commit.changes)
        if (change.lineageId) {
          const list = this.changesByLineage.get(change.lineageId) ?? [];
          list.push({ commit, change });
          this.changesByLineage.set(change.lineageId, list);
        }
    for (const pair of core.history.coChangePairs)
      for (const id of [pair.aLineageId, pair.bLineageId]) {
        const list = this.partners.get(id) ?? [];
        list.push(pair);
        this.partners.set(id, list);
      }
    for (const list of this.partners.values()) list.sort((a, b) => b.jaccard - a.jaccard || b.togetherCommits - a.togetherCommits);
    for (const plot of core.layout.plots) this.plotOf.set(plot.lineageId, plot);
    this.baseline = hotspotBaseline(head);
    this.hotspotAvailable = this.baseline.changedCommits !== null;
  }

  /** The session worker, handed to each query client in turn (StrictMode remounts reuse it). */
  get sessionWorker(): Worker | undefined {
    return this.worker;
  }

  get frames() {
    return this.manifest.frames;
  }

  /** Window commits strictly after frame `a` up to and including frame `b` (a older than b). */
  commitsBetween(a: number, b: number): HistoryCommit[] {
    const [older, newer] = a <= b ? [a, b] : [b, a];
    const from = this.chainIndex.get(this.frames[older]!.commit.oid) ?? -1;
    const to = this.chainIndex.get(this.frames[newer]!.commit.oid) ?? -1;
    return this.history.commits.filter((c) => {
      const i = this.chainIndex.get(c.oid)!;
      return i > from && i <= to;
    });
  }

  /** Path of a lineage in a frame, or its latest known path. */
  lineagePath(id: string, frame?: number): string | null {
    const lineage = this.lineages.get(id);
    if (!lineage) return null;
    if (frame !== undefined) {
      const snapshot = this.frames[frame]?.snapshotId;
      const here = lineage.occurrences.find((o) => o.snapshotId === snapshot);
      if (here) return here.path;
    }
    return lineage.occurrences.at(-1)?.path ?? lineage.anchorPath;
  }

  /** Building height of a lineage in a frame, from the layout frame state (null if absent). */
  heightIn(frame: number, lineageId: string): number | null {
    let map = this.heights.get(frame);
    if (!map) {
      map = new Map((this.layout.frameState[frame]?.files ?? []).map((f) => [f.lineageId, f.height]));
      this.heights.set(frame, map);
    }
    return map.get(lineageId) ?? null;
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
  }
}

/**
 * One analyzed frame of a dataset: its graph and the indexes derived from it. View state
 * refers to its nodes by occurrence ID and to files across frames by lineage ID.
 */
export class ViewerModel {
  readonly graph: GraphSnapshot;
  readonly index: GraphIndex;
  readonly city: CityData;
  readonly fileByLineage = new Map<string, FileNode>();
  readonly diagnostics: Diagnostic[];
  /** Containers by path (a directory and a package at one path are one place) and perimeter nodes by name. */
  private readonly places = new Map<string, GraphNode>();

  constructor(
    readonly dataset: ViewerDataset,
    readonly frame: number,
    graph: GraphSnapshot,
    prepared?: GraphIndexData,
    city?: CityData,
  ) {
    this.graph = graph;
    this.index = new GraphIndex(this.graph, prepared);
    this.city = city ?? prepareCity(this.graph, dataset.layout);
    for (const node of this.graph.nodes) {
      if (node.kind === 'file' && node.lineageId) this.fileByLineage.set(node.lineageId, node);
      const key = placeKey(node);
      if (key) this.places.set(key, node);
    }
    const rank = { error: 0, warning: 1, info: 2 } as const;
    this.diagnostics = [...this.graph.diagnostics].sort(
      (a, b) => rank[a.severity] - rank[b.severity] || compareAscii(a.ruleId, b.ruleId) || compareUtf8(this.pathOf(a.subjectIds[0]!), this.pathOf(b.subjectIds[0]!)),
    );
  }

  get manifest() {
    return this.dataset.manifest;
  }

  /** The commit this frame shows (the selected commit for the newest frame). */
  get commit() {
    return this.dataset.frames[this.frame]!.commit;
  }

  get isHead(): boolean {
    return this.frame === this.dataset.headIndex;
  }

  get snapshotId(): string {
    return this.graph.snapshotId;
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

  /**
   * The node in this frame that continues `node` from another frame: a file by lineage, a
   * container by kind and path (a directory that became a package keeps its path), a
   * perimeter node by name. Null when it does not exist here.
   */
  counterpart(node: GraphNode): GraphNode | null {
    if (node.kind === 'file') return node.lineageId ? (this.fileByLineage.get(node.lineageId) ?? null) : null;
    const key = placeKey(node);
    return key ? (this.places.get(key) ?? null) : null;
  }
}

function placeKey(node: GraphNode): string | null {
  switch (node.kind) {
    case 'repository':
      return 'repository';
    case 'package':
    case 'directory':
      return `container:${node.path}`;
    case 'external-package':
    case 'builtin':
      return perimeterName(node);
    default:
      return null;
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
  return value === null || value === undefined ? 'n/a' : value.toLocaleString('en-US');
}

const ORDINAL_RULES = new Intl.PluralRules('en-US', { type: 'ordinal' });
const ORDINAL_SUFFIX: Partial<Record<Intl.LDMLPluralRule, string>> = { one: 'st', two: 'nd', few: 'rd' };

/** English ordinal of a whole number: 1st, 2nd, 3rd, 11th, 21st, 112th. */
export function formatOrdinal(value: number): string {
  return `${formatNumber(value)}${ORDINAL_SUFFIX[ORDINAL_RULES.select(value)] ?? 'th'}`;
}

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function formatDate(iso: string): string {
  return iso.slice(0, 10);
}
