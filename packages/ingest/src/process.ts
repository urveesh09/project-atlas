import { spawn, spawnSync } from 'node:child_process';
import { IngestError } from './errors.js';

export interface BoundedRunOptions {
  /** Complete environment for the child. Nothing is inherited implicitly. */
  env: Readonly<Record<string, string>>;
  cwd: string;
  stdin?: Buffer | string;
  timeoutMs: number;
  maxStdoutBytes: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
  /** Treat these exit codes as success (default: 0 only). */
  okExitCodes?: readonly number[];
}

export interface BoundedRunResult {
  exitCode: number;
  stdout: Buffer;
  /** Truncated, for classification only. Never surfaced to users or logs verbatim. */
  stderr: string;
}

/**
 * Kill a child and every descendant. On POSIX the child leads its own process group;
 * on Windows `taskkill /T` walks the process tree. Event-loop timers alone cannot stop a
 * synchronous child, so callers rely on this for containment (plan §15.3).
 */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Run an executable with an argument array (never a shell), a fully specified
 * environment, a hard deadline and output caps.
 */
export function runBounded(executable: string, args: readonly string[], options: BoundedRunOptions): Promise<BoundedRunResult> {
  const maxStderr = options.maxStderrBytes ?? 16 * 1024;
  const okCodes = options.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new IngestError('CANCELLED', 'Operation cancelled before start'));
      return;
    }
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let failure: IngestError | null = null;
    let settled = false;

    const stop = (error: IngestError) => {
      if (failure) return;
      failure = error;
      if (child.pid !== undefined) killProcessTree(child.pid);
    };
    const timer = setTimeout(() => stop(new IngestError('TIMEOUT', 'Git operation exceeded its deadline', { timeoutMs: options.timeoutMs })), options.timeoutMs);
    const onAbort = () => stop(new IngestError('CANCELLED', 'Operation cancelled'));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > options.maxStdoutBytes) {
        stop(new IngestError('RESOURCE_LIMIT', 'Git output exceeded its byte limit', { limitBytes: options.maxStdoutBytes }));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxStderr) stderr += chunk.toString('utf8').slice(0, maxStderr - stderr.length);
    });
    child.stdin.on('error', () => {
      // The child may exit before consuming stdin (e.g. on failure); the exit status reports it.
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      reject(
        error.code === 'ENOENT'
          ? new IngestError('GIT_UNAVAILABLE', 'The Git executable was not found')
          : new IngestError('GIT_FAILED', 'Failed to start Git'),
      );
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      const exitCode = code ?? (signal ? 128 : 1);
      const result = { exitCode, stdout: Buffer.concat(stdout), stderr };
      if (!okCodes.includes(exitCode)) {
        const error = new IngestError('GIT_FAILED', 'Git command failed', { exitCode });
        (error as IngestError & { result?: BoundedRunResult }).result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}
