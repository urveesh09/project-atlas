import { setTimeout as sleep } from 'node:timers/promises';
import { forgetEndedJobs, type PublicationStore } from '@atlas/control';
import type { Pool } from 'pg';
import type { Coordinator, Logger } from './coordinator.js';
import type { JobQueue } from './queue.js';

export interface WorkerServiceOptions {
  queue: JobQueue;
  coordinator: Coordinator;
  publications: PublicationStore;
  /** Concurrent jobs; plan §4.2 starts at one per 2 GiB worker slot. */
  slots?: number;
  pollMs?: number;
  reapMs?: number;
  purgeMs?: number;
  revalidateMs?: number;
  /** Record retention (ADR-078); runs only with `pool`. */
  retentionMs?: number;
  pool?: Pool;
  /** Crash-recovery scratch sweep; directories older than one hour are removed. */
  scratchSweepMs?: number;
  log?: Logger;
}

/**
 * The worker process (plan §13.3, §15.4): claim loops for each slot plus periodic reaping,
 * purge/garbage collection, daily visibility revalidation and hourly record retention. `stop` lets running jobs
 * finish their current attempt; an interrupted process is recovered by the reaper.
 */
export class WorkerService {
  private running = false;
  private readonly loops: Promise<void>[] = [];
  private readonly log: Logger;
  constructor(private readonly options: WorkerServiceOptions) {
    this.log = options.log ?? (() => {});
    const slots = options.slots ?? 1;
    if (!Number.isInteger(slots) || slots < 1 || slots > 16) throw new Error('Worker slots must be 1-16');
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    for (let slot = 0; slot < (this.options.slots ?? 1); slot++) this.loops.push(this.claimLoop(slot));
    this.loops.push(this.every(this.options.reapMs ?? 5000, 'reap', async () => {
      const reaped = await this.options.queue.reap();
      if (reaped > 0) this.log('queue.reaped', { jobs: reaped });
    }));
    this.loops.push(this.every(this.options.purgeMs ?? 60_000, 'purge', async () => {
      const purged = await this.options.publications.purge();
      if (purged.publications + purged.objects + purged.uploads > 0) this.log('storage.purged', purged);
    }));
    this.loops.push(this.every(this.options.scratchSweepMs ?? 600_000, 'scratch', async () => {
      const removed = await this.options.coordinator.sweepScratch();
      if (removed > 0) this.log('scratch.swept', { directories: removed });
    }));
    this.loops.push(this.every(this.options.revalidateMs ?? 3_600_000, 'revalidate', async () => {
      const result = await this.options.publications.revalidate();
      if (result.checked > 0) this.log('visibility.revalidated', result);
    }));
    const pool = this.options.pool;
    if (pool) {
      this.loops.push(this.every(this.options.retentionMs ?? 3_600_000, 'retention', async () => {
        const forgotten = await forgetEndedJobs(pool);
        if (forgotten.jobs + forgotten.repositories > 0) this.log('records.forgotten', { ...forgotten });
      }));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.allSettled(this.loops);
    this.loops.length = 0;
  }

  private async claimLoop(slot: number): Promise<void> {
    while (this.running) {
      let worked = false;
      try {
        worked = await this.options.coordinator.runOnce();
      } catch (error) {
        this.log('worker.loop-error', { slot, error: error instanceof Error ? error.name : 'unknown' });
      }
      if (!worked) await this.pause(this.options.pollMs ?? 1000);
    }
  }

  private async every(intervalMs: number, name: string, work: () => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        await work();
      } catch (error) {
        this.log('worker.sweep-error', { sweep: name, error: error instanceof Error ? error.name : 'unknown' });
      }
      await this.pause(intervalMs);
    }
  }

  /** Sleep in short steps so `stop` is prompt. */
  private async pause(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) await sleep(Math.min(250, until - Date.now()));
  }
}
