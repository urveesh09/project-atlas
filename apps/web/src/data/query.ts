import type { FrameComparison, ReachResult, SearchHit } from '@atlas/graph';
import type { CityData } from '@atlas/layout';
import type { GraphSnapshot } from '@atlas/schema';
import type { OverlayOptions, OverlayResult } from '../city/overlay';
import type { PreparedFrame, QueryRequest } from './query.worker';

type Body<T extends QueryRequest['type']> = Omit<Extract<QueryRequest, { type: T }>, 'id'>;

// A retained worker can outlive a client (StrictMode/remount). IDs must never be
// reused by its replacement while an old response is still in flight.
const requestSerials = new WeakMap<Worker, number>();

/**
 * Promise client for the graph query worker. Every request names its frame; callers
 * compare the frame of a response with the one they still display (latest request wins).
 * The worker belongs to the dataset session (ADR-023, amended by ADR-027): closing a
 * client rejects its pending requests but leaves a session worker for the next client.
 * A request past its deadline means a stalled worker, which is terminated either way.
 */
export class QueryClient {
  private readonly worker: Worker;
  private readonly owned: boolean;
  private failed: string | null = null;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(head: { graph: GraphSnapshot; city: CityData; frame: number }, sessionWorker?: Worker) {
    this.owned = !sessionWorker;
    this.worker = sessionWorker ?? new Worker(new URL('./query.worker.ts', import.meta.url), { type: 'module', name: 'atlas-graph-queries' });
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer);
      this.pending.delete(data.id);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.result);
    };
    this.worker.onerror = () => this.fail('The graph query worker stopped');
    if (this.owned) void this.send('init', { type: 'init', graph: head.graph, city: head.city, frame: head.frame }).catch(() => this.fail('The graph query index could not initialize'));
  }

  private send<T extends QueryRequest['type']>(_type: T, request: Body<T>, deadlineMs = 20_000): Promise<unknown> {
    const id = (requestSerials.get(this.worker) ?? 0) + 1;
    requestSerials.set(this.worker, id);
    if (this.failed) return Promise.reject(new Error(this.failed));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many pending graph queries'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('The graph query deadline was exceeded', true), deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...request, id });
      } catch {
        this.fail('The graph query could not be sent');
      }
    });
  }

  frame(frame: number): Promise<PreparedFrame> {
    return this.send('frame', { type: 'frame', frame }, 60_000) as Promise<PreparedFrame>;
  }
  search(frame: number, query: string): Promise<SearchHit[]> {
    return this.send('search', { type: 'search', frame, query }) as Promise<SearchHit[]>;
  }
  reach(frame: number, nodeId: string, direction: 'outgoing' | 'incoming', depth: number): Promise<ReachResult> {
    return this.send('reach', { type: 'reach', frame, nodeId, direction, depth }) as Promise<ReachResult>;
  }
  overlay(frame: number, options: OverlayOptions): Promise<OverlayResult> {
    return this.send('overlay', { type: 'overlay', frame, options }) as Promise<OverlayResult>;
  }
  compare(a: number, b: number): Promise<FrameComparison> {
    return this.send('compare', { type: 'compare', a, b }, 60_000) as Promise<FrameComparison>;
  }

  private fail(message: string, terminate = this.owned) {
    if (this.failed) return;
    this.failed = message;
    if (terminate) this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }

  dispose() {
    this.fail('The dataset was closed');
    if (!this.owned) this.worker.onmessage = null;
  }
}
