import { fork, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { failedSyntaxFacts, type SyntaxFacts } from './facts.js';
import { parserWorkerPath } from './worker-path.js';
import { killProcessTree } from '@atlas/ingest';
import { LIMITS } from '@atlas/schema';

/**
 * Bounded parser children (plan §15.3, task P2.5). Each child parses one file at a time
 * under a hard per-file deadline and a heap limit. A deadline or crash kills the child's
 * whole process tree, records the file as a failed parse with a reason, and starts a
 * fresh child; it never takes down the analysis or leaves a runaway process behind.
 */
export interface ParserPoolOptions {
  workers?: number;
  deadlineMs?: number;
  heapMiB?: number;
  /** Override for tests; defaults to the compiled analyzer-ts worker. */
  workerPath?: string;
}

interface Job {
  id: number;
  path: string;
  text: string;
  resolve: (facts: SyntaxFacts) => void;
}

interface Slot {
  child: ChildProcess | null;
  ready: Promise<void> | null;
  job: Job | null;
  timer: NodeJS.Timeout | null;
}

export interface ParserPoolStats {
  parsed: number;
  timeouts: number;
  crashes: number;
  restarts: number;
}

export class ParserPool {
  private readonly queue: Job[] = [];
  private readonly slots: Slot[];
  private readonly deadlineMs: number;
  private readonly heapMiB: number;
  private readonly workerPath: string;
  private nextId = 1;
  private closed = false;
  readonly stats: ParserPoolStats = { parsed: 0, timeouts: 0, crashes: 0, restarts: 0 };

  constructor(options: ParserPoolOptions = {}) {
    this.deadlineMs = options.deadlineMs ?? LIMITS.perFileParseDeadlineMs;
    this.heapMiB = options.heapMiB ?? 512;
    this.workerPath = options.workerPath ?? parserWorkerPath();
    if (!existsSync(this.workerPath)) throw new Error(`Parser worker not built: ${this.workerPath}`);
    this.slots = Array.from({ length: Math.max(1, options.workers ?? 2) }, () => ({ child: null, ready: null, job: null, timer: null }));
  }

  /** Parse one file. Never rejects for file-level problems: they become failed facts. */
  parse(path: string, text: string): Promise<SyntaxFacts> {
    if (this.closed) return Promise.reject(new Error('ParserPool is closed'));
    return new Promise((resolve) => {
      this.queue.push({ id: this.nextId++, path, text, resolve });
      this.pump();
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.slots) this.stop(slot);
    for (const job of this.queue.splice(0)) job.resolve(failedSyntaxFacts(job.path, job.text, 'PARSER_CRASHED'));
  }

  private spawn(slot: Slot): void {
    const child = fork(this.workerPath, [], {
      execArgv: [`--max-old-space-size=${this.heapMiB}`],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Only what Node needs to start; the parser has no use for the caller's environment.
      env: { ...(process.env['SystemRoot'] ? { SystemRoot: process.env['SystemRoot'] } : {}) },
      windowsHide: true,
    });
    slot.child = child;
    slot.ready = new Promise((resolve) => {
      const onReady = (message: { type?: string }) => {
        if (message?.type === 'ready') {
          child.off('message', onReady);
          resolve();
        }
      };
      child.on('message', onReady);
    });
    child.on('message', (message: { type: string; id: number; facts?: SyntaxFacts }) => {
      const job = slot.job;
      if (!job || message.id !== job.id) return;
      if (message.type === 'result' && message.facts) this.finish(slot, message.facts, false);
      else this.finish(slot, failedSyntaxFacts(job.path, job.text, 'PARSER_CRASHED'), false);
    });
    child.on('exit', () => {
      if (slot.child !== child) return;
      slot.child = null;
      slot.ready = null;
      if (slot.job) {
        this.stats.crashes++;
        this.finish(slot, failedSyntaxFacts(slot.job.path, slot.job.text, 'PARSER_CRASHED'), false);
      }
    });
  }

  private stop(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    const child = slot.child;
    slot.child = null;
    slot.ready = null;
    if (child?.pid !== undefined && child.exitCode === null) {
      killProcessTree(child.pid);
      child.kill('SIGKILL');
    }
  }

  private finish(slot: Slot, facts: SyntaxFacts, timedOut: boolean): void {
    const job = slot.job;
    if (!job) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    if (timedOut) {
      this.stats.timeouts++;
      this.stop(slot);
    } else if (facts.failureReason !== 'PARSER_CRASHED') this.stats.parsed++;
    job.resolve(facts);
    this.pump();
  }

  private pump(): void {
    for (const slot of this.slots) {
      if (slot.job || this.queue.length === 0 || this.closed) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      if (!slot.child) {
        if (this.stats.parsed + this.stats.timeouts + this.stats.crashes > 0) this.stats.restarts++;
        this.spawn(slot);
      }
      const child = slot.child!;
      void slot.ready!.then(() => {
        if (slot.job !== job || slot.child !== child) return;
        // The deadline starts when the child can begin work, so startup is not charged.
        slot.timer = setTimeout(() => this.finish(slot, failedSyntaxFacts(job.path, job.text, 'PARSE_TIMEOUT'), true), this.deadlineMs);
        child.send({ type: 'parse', id: job.id, path: job.path, text: job.text });
      });
    }
  }
}
