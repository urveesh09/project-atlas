import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXIT, run, type CliIO } from '@atlas/cli';
import { buildDemoRepository, buildInventoryFixture, type GitFixture, type InventoryFixture } from '@atlas/test-fixtures';

/**
 * P1.5 / Gate G1: the CLI end to end. Commands run in-process with captured streams (and
 * one real spawned binary), against real Git repositories, with network access trapped.
 */
interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

async function atlas(args: string[], options: { cwd: string; env?: Record<string, string>; signal?: AbortSignal }): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    stdout: { write: (t: string) => (stdout += t), isTTY: false, columns: 100 },
    stderr: { write: (t: string) => (stderr += t), isTTY: false, columns: 100 },
    env: { NO_COLOR: '1', ...options.env },
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
  };
  const code = await run(args, io);
  return { code, stdout, stderr };
}

/** Fingerprint of a .git directory: every file's path, size and content hash. */
function gitFingerprint(dir: string): string {
  const hash = createHash('sha256');
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(dir, full)}\0${statSync(full).size}\0`).update(readFileSync(full));
    }
  };
  walk(path.join(dir, '.git'));
  return hash.digest('hex');
}

let work: string;
let demo: GitFixture;
let inventory: InventoryFixture;
const originalConnect = net.Socket.prototype.connect;
let connectAttempts = 0;

beforeAll(() => {
  work = mkdtempSync(path.join(tmpdir(), 'atlas-cli-'));
  demo = buildDemoRepository();
  inventory = buildInventoryFixture();
  // Trap any in-process network attempt for the whole suite (child Git runs offline by policy).
  net.Socket.prototype.connect = function trapped(this: net.Socket, ...args: unknown[]) {
    connectAttempts++;
    return (originalConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
});
afterAll(() => {
  net.Socket.prototype.connect = originalConnect;
  demo?.dispose();
  inventory?.repo.dispose();
  rmSync(work, { recursive: true, force: true });
});

describe('atlas analyze', () => {
  it('analyzes the committed tree without network access and without touching .git', async () => {
    const before = gitFingerprint(demo.dir);
    writeFileSync(path.join(demo.dir, 'src', 'uncommitted.ts'), 'export const dirty = true;\n');
    try {
      const result = await atlas(['analyze', demo.dir, '--out', 'harbor-out'], { cwd: work });
      expect(result.code, result.stderr).toBe(EXIT.ok);
      expect(result.stderr).toContain('committed files only');
      expect(result.stderr).toContain('never contains source text');
      const summary = JSON.parse(readFileSync(path.join(work, 'harbor-out', 'summary.json'), 'utf8'));
      expect(summary.files.included).toBe(26);
      expect(JSON.stringify(summary)).not.toContain('uncommitted.ts');
    } finally {
      rmSync(path.join(demo.dir, 'src', 'uncommitted.ts'));
    }
    expect(gitFingerprint(demo.dir)).toBe(before);
    expect(connectAttempts).toBe(0);
  });

  it('writes an artifact that verify and inspect accept', async () => {
    const verify = await atlas(['verify', 'harbor-out'], { cwd: work });
    expect(verify.code).toBe(EXIT.ok);
    expect(verify.stdout).toContain('Artifact is valid.');
    const inspect = await atlas(['inspect', 'harbor-out', '--json'], { cwd: work });
    expect(inspect.code).toBe(EXIT.ok);
    const report = JSON.parse(inspect.stdout);
    expect(report.packages.map((p: { path: string; files: number }) => [p.path, p.files])).toEqual([
      ['', 18],
      ['packages/geo', 4],
      ['packages/ledger', 4],
    ]);
    expect(report.externalPackages).toEqual(['decimal.js', 'react', 'typescript', 'vitest', 'zod']);
    const human = await atlas(['inspect', 'harbor-out'], { cwd: work });
    expect(human.stdout).toContain('CITY PLAN');
    expect(human.stdout).toContain('DISTRICTS');
    expect(human.stdout).toMatch(/@harbor\/geo\s+4/);
  });

  it('refuses to overwrite, then replaces while keeping the repository identity', async () => {
    const identity = JSON.parse(readFileSync(path.join(work, 'harbor-out', 'repository-id.json'), 'utf8'));
    const again = await atlas(['analyze', demo.dir, '--out', 'harbor-out'], { cwd: work });
    expect(again.code).toBe(EXIT.failure);
    expect(again.stderr).toContain('OUTPUT_EXISTS');
    const replaced = await atlas(['analyze', demo.dir, '--out', 'harbor-out', '--replace'], { cwd: work });
    expect(replaced.code).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(path.join(work, 'harbor-out', 'repository-id.json'), 'utf8'))).toEqual(identity);
  });

  it('reuses identity with --previous, making snapshot IDs reproducible', async () => {
    const result = await atlas(['analyze', demo.dir, '--out', 'harbor-next', '--previous', 'harbor-out', '--json'], { cwd: work });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    const lines = result.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].type).toBe('start');
    expect(lines.at(-1).type).toBe('result');
    const a = JSON.parse(readFileSync(path.join(work, 'harbor-out', 'manifest.json'), 'utf8'));
    const b = JSON.parse(readFileSync(path.join(work, 'harbor-next', 'manifest.json'), 'utf8'));
    expect(b.chunks).toEqual(a.chunks);
    expect(b.repo.repoId).toBe(a.repo.repoId);
  });

  it('exits 2 with explicit omissions when a lowered limit makes the result partial', async () => {
    const result = await atlas(['analyze', demo.dir, '--out', 'harbor-partial', '--max-files', '5'], { cwd: work });
    expect(result.code).toBe(EXIT.partial);
    expect(result.stderr).toContain('Partial');
    const report = JSON.parse((await atlas(['inspect', 'harbor-partial', '--json'], { cwd: work })).stdout);
    expect(report.files).toMatchObject({ included: 5, omitted: 21 });
    expect(report.limitsHit).toEqual(['FILE_LIMIT']);
  });

  it('cancels cleanly with exit 130 and no output', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await atlas(['analyze', demo.dir, '--out', 'harbor-cancelled'], { cwd: work, signal: controller.signal });
    expect(result.code).toBe(EXIT.cancelled);
    expect(existsSync(path.join(work, 'harbor-cancelled'))).toBe(false);
    expect(readdirSync(work).some((e) => e.includes('atlas-staging'))).toBe(false);
  });

  it('refuses to write over the repository itself', async () => {
    const result = await atlas(['analyze', demo.dir, '--out', demo.dir, '--replace'], { cwd: work });
    expect(result.code).toBe(EXIT.failure);
    expect(result.stderr).toMatch(/OUTPUT_(UNSAFE|EXISTS|NOT_ARTIFACT)/);
  });
});

describe('Gate G1: hierarchy and explicit omissions for the inventory fixture', () => {
  it('reports every exclusion reason and keeps opaque files visible', async () => {
    const result = await atlas(['analyze', inventory.repo.dir, '--out', 'inventory-out'], { cwd: work });
    expect(result.code, result.stderr).toBe(EXIT.ok);
    const report = JSON.parse((await atlas(['inspect', 'inventory-out', '--json'], { cwd: work })).stdout);
    const reasons = Object.fromEntries(report.coverageReasons.map((r: { code: string; count: number }) => [r.code, r.count]));
    const expected: Record<string, number> = {};
    for (const e of inventory.entries) {
      const reason = e.expected.status === 'excluded' ? e.expected.reason : e.expected.status === 'opaque' ? e.expected.reason : null;
      if (reason) expected[reason] = (expected[reason] ?? 0) + 1;
    }
    expect(reasons).toEqual(expected);
    const included = inventory.entries.filter((e) => e.expected.status !== 'excluded').length;
    expect(report.files).toMatchObject({ discovered: inventory.entries.length, included, excluded: inventory.entries.length - included, omitted: 0 });
    const human = (await atlas(['inspect', 'inventory-out'], { cwd: work })).stdout;
    expect(human).toContain('NOT ANALYZED, AND WHY');
    expect(human).toContain('symbolic links (never followed)');
  });
});

describe('arguments and exit codes', () => {
  it.each([
    [['frobnicate'], 'Unknown command'],
    [['analyze', '.', '--bogus'], 'bogus'],
    [['analyze', '.', '--snapshots', '13'], '--snapshots'],
    [['analyze', '.', '--no-history', '--snapshots', '3'], 'conflicts'],
    [['analyze', '.', '--repo-id', 'not-a-uuid'], '--repo-id'],
    [['analyze', '.', '--exclude', '!negated'], 'Unsupported exclusion pattern'],
    [['inspect'], 'one artifact'],
  ])('%j is a usage error', async (args, message) => {
    const result = await atlas(args, { cwd: demo.dir });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain(message);
  });

  it('rejects revision expressions as refs', async () => {
    const result = await atlas(['analyze', demo.dir, '--out', 'never', '--ref', 'HEAD~1'], { cwd: work });
    expect(result.code).toBe(EXIT.usage);
    expect(result.stderr).toContain('REF_INVALID');
  });

  it('fails verification of a corrupted artifact', async () => {
    const manifest = path.join(work, 'harbor-next', 'manifest.json');
    const m = JSON.parse(readFileSync(manifest, 'utf8'));
    m.frames[0].nodeCount += 1;
    writeFileSync(manifest, JSON.stringify(m));
    const result = await atlas(['verify', 'harbor-next'], { cwd: work });
    expect(result.code).toBe(EXIT.failure);
    expect(result.stdout).toContain('FRAME_MISMATCH');
  });

  it('runs doctor', async () => {
    const result = await atlas(['doctor', '--json'], { cwd: work });
    const report = JSON.parse(result.stdout);
    expect(report.checks.find((c: { id: string }) => c.id === 'isolation').status).toBe('ok');
    expect(result.code).toBe(report.ok ? EXIT.ok : EXIT.failure);
  });
});

describe('the real binary', () => {
  const bin = fileURLToPath(new URL('../bin/atlas.js', import.meta.url));
  it.runIf(existsSync(fileURLToPath(new URL('../dist/main.js', import.meta.url))))('prints its version and help', () => {
    const version = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe('0.1.0-dev');
    const help = spawnSync(process.execPath, [bin], { encoding: 'utf8' });
    expect(help.status).toBe(EXIT.usage);
    expect(help.stdout).toContain('Exit codes');
  });
});
