import { bakeOcclusion, type OcclusionGrid } from './occlusion';

/** The part of a Worker the baker uses, so tests can stand in for one. */
export interface BakeWorker {
  postMessage(message: { id: number; grid: OcclusionGrid; occluders: Float32Array }): void;
  terminate(): void;
  onmessage: ((event: { data: { id: number; field: Uint8Array } }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/**
 * Schedules sky-occlusion bakes (ADR-042): in a worker when one starts, otherwise on the
 * main thread after the current task. Only the latest request is ever applied. When the
 * worker fails, every later bake runs inline, starting with the latest request still
 * pending (not the one that was pending when the worker was created).
 */
export class OcclusionBaker {
  private worker: BakeWorker | false | null = null;
  private ticket = 0;
  private pending: { ticket: number; grid: OcclusionGrid; occluders: Float32Array } | null = null;
  private disposed = false;

  constructor(
    private readonly apply: (field: Uint8Array) => void,
    private readonly spawn: () => BakeWorker,
    private readonly defer: (run: () => void) => void = (run) => void setTimeout(run, 0),
  ) {}

  /** True once the latest requested bake has been applied. */
  get ready(): boolean {
    return this.pending === null;
  }

  bake(grid: OcclusionGrid, occluders: Float32Array) {
    if (this.disposed) return;
    const ticket = ++this.ticket;
    this.pending = { ticket, grid, occluders };
    if (this.worker === false) return this.inline();
    try {
      this.worker ??= this.start();
      // Copied, not transferred: the inline fallback may still need these occluders.
      this.worker.postMessage({ id: ticket, grid, occluders });
    } catch {
      this.fail();
    }
  }

  dispose() {
    this.disposed = true;
    this.pending = null;
    if (this.worker) this.worker.terminate();
    this.worker = false;
  }

  private start(): BakeWorker {
    const worker = this.spawn();
    worker.onmessage = ({ data }) => {
      if (this.disposed || data.id !== this.pending?.ticket) return;
      this.pending = null;
      this.apply(data.field);
    };
    worker.onerror = () => this.fail();
    return worker;
  }

  private fail() {
    if (this.worker) this.worker.terminate();
    this.worker = false;
    this.inline();
  }

  /** Bake the latest pending request here, unless a newer one replaces it first. */
  private inline() {
    const job = this.pending;
    if (!job || this.disposed) return;
    this.defer(() => {
      if (this.disposed || this.pending !== job) return;
      this.pending = null;
      this.apply(bakeOcclusion(job.grid, job.occluders));
    });
  }
}
