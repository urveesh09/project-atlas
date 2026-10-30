import { createStyler, detectColorLevel, type Styler } from './ui/style.js';

/** Everything a command may touch, injected so commands are testable in-process. */
export interface CliIO {
  stdout: { write(text: string): unknown; isTTY?: boolean; columns?: number };
  stderr: { write(text: string): unknown; isTTY?: boolean; columns?: number };
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
  /** Aborted on SIGINT by the real entry point; tests abort it directly. */
  signal: AbortSignal;
}

export interface CommandContext {
  io: CliIO;
  /** Styler for human output on stderr (progress) and stdout (reports). */
  out: Styler;
  err: Styler;
  width: number;
  json: boolean;
  print(line?: string): void;
  note(line?: string): void;
}

export const EXIT = { ok: 0, failure: 1, partial: 2, policyBlocked: 3, usage: 64, cancelled: 130 } as const;

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function createContext(io: CliIO, json: boolean): CommandContext {
  const unicode = io.env['ATLAS_ASCII'] !== '1';
  const out = createStyler(json ? 0 : detectColorLevel(io.env, io.stdout.isTTY === true), unicode);
  const err = createStyler(detectColorLevel(io.env, io.stderr.isTTY === true), unicode);
  const width = Math.max(60, Math.min(110, io.stdout.columns ?? 100));
  return {
    io,
    out,
    err,
    width,
    json,
    print: (line = '') => io.stdout.write(`${line}\n`),
    note: (line = '') => io.stderr.write(`${line}\n`),
  };
}
