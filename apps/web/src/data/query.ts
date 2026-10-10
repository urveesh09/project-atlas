import type { SearchHit, ReachResult } from '@atlas/graph';
import type { CityData } from '@atlas/layout';
import type { GraphSnapshot } from '@atlas/schema';
import type { OverlayOptions, OverlayResult } from '../city/overlay';
import type { QueryRequest } from './query.worker';

export class QueryClient {
  private readonly worker: Worker;
  private serial = 0;
  private failed: string | null = null;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  constructor(graph: GraphSnapshot, city: CityData, preparedWorker?: Worker) {
    this.worker =
      preparedWorker ??
      new Worker(new URL('./query.worker.ts', import.meta.url), { type: 'module', name: 'atlas-graph-queries' });
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const request = this.pending.get(data.id);
      if (request) clearTimeout(request.timer);
      this.pending.delete(data.id);
      if (data.error) request?.reject(new Error(data.error));
      else request?.resolve(data.result);
    };
    this.worker.onerror = () => this.fail('The graph query worker stopped');
    if (!preparedWorker)
      void this.send({ type: 'init', graph, city }).catch(() =>
        this.fail('The graph query index could not initialize'),
      );
  }
  private send(
    request:
      | Omit<Extract<QueryRequest, { type: 'init' }>, 'id'>
      | Omit<Extract<QueryRequest, { type: 'search' }>, 'id'>
      | Omit<Extract<QueryRequest, { type: 'reach' }>, 'id'>
      | Omit<Extract<QueryRequest, { type: 'overlay' }>, 'id'>,
  ): Promise<unknown> {
    const id = ++this.serial;
    if (this.failed) return Promise.reject(new Error(this.failed));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many pending graph queries'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('The graph query deadline was exceeded'), 20_000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ ...request, id });
      } catch {
        this.fail('The graph query could not be sent');
      }
    });
  }
  search(query: string): Promise<SearchHit[]> {
    return this.send({ type: 'search', query }) as Promise<SearchHit[]>;
  }
  reach(nodeId: string, direction: 'outgoing' | 'incoming', depth: number): Promise<ReachResult> {
    return this.send({ type: 'reach', nodeId, direction, depth }) as Promise<ReachResult>;
  }
  overlay(options: OverlayOptions): Promise<OverlayResult> {
    return this.send({ type: 'overlay', options }) as Promise<OverlayResult>;
  }
  private fail(message: string) {
    if (this.failed) return;
    this.failed = message;
    this.worker.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }
  dispose() {
    this.fail('The dataset was closed');
  }
}
