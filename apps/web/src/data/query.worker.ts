import type { OpenedArtifact } from '@atlas/artifact';
import { GraphIndex, SearchIndex, applyReviewWorkspaceEdits, compareFrames, hotspotBaseline, hotspotFactors, parseArchitectureReview, parseReviewWorkspace, recomputeArchitectureReview, type GraphIndexData, type WorkspaceDecisionEdit } from '@atlas/graph';
import { prepareCity, type CityData } from '@atlas/layout';
import { ARCHITECTURE_LIMITS, WORKSPACE_LIMITS, canonicalJson, type ArchitectureReview, type ArtifactManifest, type GraphSnapshot, type ReviewWorkspace } from '@atlas/schema';
import { buildOverlay, prepareOverlayLookup, type OverlayOptions } from '../city/overlay';

/**
 * Graph queries for every analyzed frame, off the main thread (plan §15.3). The retained
 * loader worker owns the lazily opened artifact: the selected (HEAD) frame is pinned and
 * at most two other frames stay decoded in an LRU (plan §15.3: "active graph plus at most
 * two nearby historical frames"). Every request names its frame, so a response can never
 * be applied to a different snapshot than the one it was computed for.
 */
export type QueryRequest =
  | { id: number; type: 'init'; graph: GraphSnapshot; city: CityData; frame: number }
  | { id: number; type: 'frame'; frame: number }
  | { id: number; type: 'search'; frame: number; query: string }
  | { id: number; type: 'reach'; frame: number; nodeId: string; direction: 'outgoing' | 'incoming'; depth: number }
  | { id: number; type: 'overlay'; frame: number; options: OverlayOptions }
  | { id: number; type: 'compare'; a: number; b: number }
  | { id: number; type: 'architecture'; file: File; input: ArchitectureInput }
  | { id: number; type: 'architecture-copy'; workspace: ReviewWorkspace; edits: WorkspaceDecisionEdit[] };

export type ArchitectureInput = 'report' | 'workspace';
export interface ArchitectureEvidence {
  report: ArchitectureReview;
  workspace: ReviewWorkspace | null;
}

export interface PreparedFrame {
  frame: number;
  graph: GraphSnapshot;
  prepared: GraphIndexData;
  city: CityData;
}

const scope = self as unknown as {
  postMessage(message: { id: number; result?: unknown; error?: string }): void;
  onmessage: ((event: MessageEvent<QueryRequest>) => void) | null;
};

interface FrameEntry {
  graph: GraphSnapshot;
  index: GraphIndex;
  city: CityData;
  search: SearchIndex | null;
}

/** Decoded frames with HEAD pinned and a size-aware LRU for the rest. */
export class FrameStore {
  private readonly cache = new Map<number, FrameEntry>();
  private readonly pending = new Map<number, Promise<FrameEntry>>();
  private readonly capacity: number;
  readonly headIndex: number;

  constructor(
    private readonly opened: Pick<OpenedArtifact, 'frame' | 'layout'> | null,
    head: { frame: number; graph: GraphSnapshot; index: GraphIndex; city: CityData },
    private readonly manifest: Pick<ArtifactManifest, 'analysisId' | 'repo' | 'frames'> | null = null,
  ) {
    this.headIndex = head.frame;
    this.cache.set(head.frame, { graph: head.graph, index: head.index, city: head.city, search: null });
    prepareOverlayLookup(head.city);
    // Dense graphs keep one historical neighbour; ordinary ones keep two.
    this.capacity = head.graph.edges.length + head.graph.importObservations.length > 60_000 ? 1 : 2;
  }

  /** Structure attention against the HEAD baseline, shared by every frame's city. */
  static attention(head: GraphSnapshot) {
    const baseline = hotspotBaseline(head);
    return (node: Parameters<typeof hotspotFactors>[1], metric: Parameters<typeof hotspotFactors>[2]) => hotspotFactors(baseline, node, metric)?.structureAttention ?? null;
  }

  async get(frame: number): Promise<FrameEntry> {
    const hit = this.cache.get(frame);
    if (hit) {
      if (frame !== this.headIndex) {
        this.cache.delete(frame);
        this.cache.set(frame, hit);
      }
      return hit;
    }
    const inflight = this.pending.get(frame);
    if (inflight) return inflight;
    if (!this.opened) throw new Error('Historical frames are unavailable in this session');
    const opened = this.opened;
    const head = this.cache.get(this.headIndex)!;
    const load = (async () => {
      const result = await opened.frame(frame);
      if (!result.ok) throw new Error(`Frame ${frame} failed validation (${result.issues[0]?.code ?? 'ARTIFACT_INVALID'})`);
      const graph = result.graph;
      const entry: FrameEntry = { graph, index: new GraphIndex(graph), city: prepareCity(graph, opened.layout, { attention: FrameStore.attention(head.graph) }), search: null };
      this.cache.set(frame, entry);
      const historical = [...this.cache.keys()].filter((k) => k !== this.headIndex);
      while (historical.length > this.capacity) this.cache.delete(historical.shift()!);
      return entry;
    })();
    this.pending.set(frame, load);
    try {
      return await load;
    } finally {
      this.pending.delete(frame);
    }
  }

  /** Only recomputed evidence and a checked workspace cross back to the UI. */
  async architecture(file: File, input: ArchitectureInput): Promise<ArchitectureEvidence> {
    if (!this.manifest) throw new Error('Architecture review could not be checked against this artifact.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: input === 'workspace' }).decode(await file.arrayBuffer());
    const workspace = input === 'workspace' ? parseReviewWorkspace(text) : null;
    const report = await this.verifyArchitecture(workspace?.report ?? parseArchitectureReview(text));
    return { report, workspace: workspace ? { ...workspace, report } : null };
  }

  async architectureCopy(workspace: ReviewWorkspace, edits: WorkspaceDecisionEdit[]): Promise<Blob> {
    const updated = applyReviewWorkspaceEdits(workspace, workspace.revision, edits);
    const report = await this.verifyArchitecture(updated.report);
    return new Blob([canonicalJson({ ...updated, report }) + '\n'], { type: 'application/json' });
  }

  private async verifyArchitecture(declared: ArchitectureReview): Promise<ArchitectureReview> {
    const manifest = this.manifest;
    if (!manifest) throw new Error('Architecture review could not be checked against this artifact.');
    if (declared.analysisId !== manifest.analysisId || declared.repoId !== manifest.repo.repoId)
      throw new Error('Architecture review does not belong to this artifact.');
    const at = (side: typeof declared.current) => manifest.frames.findIndex(f => f.snapshotId === side.snapshotId && f.commit.oid === side.commitOid);
    const currentAt = at(declared.current), baselineAt = declared.baseline ? at(declared.baseline) : -1;
    if (currentAt < 0 || (declared.baseline && (baselineAt < 0 || baselineAt >= currentAt)))
      throw new Error('Architecture review snapshot order does not match this artifact.');
    const current = await this.get(currentAt);
    const baseline = baselineAt < 0 ? null : await this.get(baselineAt);
    return recomputeArchitectureReview(declared, manifest.analysisId, current.graph, baseline?.graph ?? null);
  }
}

let store: FrameStore | null = null;

export function initializeQueries(next: FrameStore) {
  store = next;
}

/** Standalone session (development remounts): HEAD only, no artifact to decode from. */
function standalone(graph: GraphSnapshot, city: CityData, frame: number): FrameStore {
  return new FrameStore(null, { frame, graph, index: new GraphIndex(graph), city });
}

export async function handleQuery(q: QueryRequest, channel?: Pick<MessageEvent, 'origin' | 'source' | 'isTrusted'>) {
  try {
    if ((q.type === 'architecture' || q.type === 'architecture-copy')
      && (!channel || channel.origin !== '' || channel.source !== null || !channel.isTrusted
        || !Number.isSafeInteger(q.id) || q.id < 1)) throw new Error('Architecture request was rejected.');
    if (q.type === 'architecture') {
      if (!(q.file instanceof File)
        || (q.input !== 'report' && q.input !== 'workspace')) throw new Error('Architecture review request was rejected.');
      const limit = q.input === 'workspace' ? WORKSPACE_LIMITS.bytes : ARCHITECTURE_LIMITS.reportBytes;
      if (q.file.size > limit) throw new Error('Architecture input exceeds its byte limit.');
    }
    if (q.type === 'architecture-copy' && (!Array.isArray(q.edits) || !q.edits.length || q.edits.length > WORKSPACE_LIMITS.decisions))
      throw new Error('Architecture draft exceeds its edit limit.');
    if (q.type === 'init') {
      initializeQueries(standalone(q.graph, q.city, q.frame));
      scope.postMessage({ id: q.id, result: true });
      return;
    }
    if (!store) throw new Error('The query index is not ready');
    let result: unknown;
    switch (q.type) {
      case 'architecture':
        result = await store.architecture(q.file, q.input);
        break;
      case 'architecture-copy':
        result = await store.architectureCopy(q.workspace, q.edits);
        break;
      case 'frame': {
        const entry = await store.get(q.frame);
        result = { frame: q.frame, graph: entry.graph, prepared: entry.index.transferData(), city: entry.city } satisfies PreparedFrame;
        break;
      }
      case 'search': {
        const entry = await store.get(q.frame);
        entry.search ??= new SearchIndex(entry.graph);
        result = entry.search.search(q.query.slice(0, 512), 30);
        break;
      }
      case 'reach':
        result = (await store.get(q.frame)).index.reach(q.nodeId, { direction: q.direction, depth: q.depth });
        break;
      case 'overlay': {
        const entry = await store.get(q.frame);
        result = buildOverlay(entry.index, entry.city, q.options);
        break;
      }
      case 'compare': {
        const a = await store.get(q.a);
        const b = await store.get(q.b);
        result = compareFrames(a.graph, b.graph);
        break;
      }
    }
    scope.postMessage({ id: q.id, result });
  } catch (e) {
    const error = q.type === 'architecture' ? 'Architecture review could not be checked. Existing evidence is unchanged.'
      : q.type === 'architecture-copy' ? 'Workspace copy could not be prepared.'
      : e instanceof Error ? e.message : 'Query failed';
    scope.postMessage({ id: q.id, error });
  }
}
scope.onmessage = (event) => void handleQuery(event.data, event);
