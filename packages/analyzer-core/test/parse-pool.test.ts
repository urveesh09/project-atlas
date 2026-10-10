import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DirectoryFactCache, MemoryFactCache, ParserPool, factCacheKey, isCacheable } from '@atlas/analyzer-core';
import { extractFileFacts, failedFacts } from '@atlas/analyzer-ts';
import { sha256Hex } from '@atlas/schema';

const hostile = fileURLToPath(new URL('./fixtures/hostile-worker.mjs', import.meta.url));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('parser pool with the real worker', () => {
  const pool = new ParserPool({ workers: 2 });
  afterAll(() => pool.close());

  it('returns exactly the in-process facts, regardless of completion order', async () => {
    const inputs = Array.from({ length: 40 }, (_, i) => [`f${i}.ts`, `export function f${i}(a: number) { return a > ${i} ? ${i} : -${i}; }\n${'// pad\n'.repeat(i * 50)}`] as const);
    const results = await Promise.all(inputs.map(([p, t]) => pool.parse(p, t)));
    results.forEach((facts, i) => expect(facts).toEqual(extractFileFacts(inputs[i]![0], inputs[i]![1])));
    expect(pool.stats.parsed).toBe(40);
  });

  it('reports syntax errors as content facts, not pool failures', async () => {
    const facts = await pool.parse('bad.ts', 'const = ;');
    expect(facts).toMatchObject({ parseStatus: 'failed', failureReason: 'SYNTAX_ERROR' });
  });
});

describe('containment with a misbehaving worker', () => {
  it('kills a child that exceeds the deadline and keeps serving', async () => {
    const pool = new ParserPool({ workers: 1, deadlineMs: 300, workerPath: hostile });
    try {
      const started = Date.now();
      const [hang, ok] = await Promise.all([pool.parse('hang.ts', ''), pool.parse('ok.ts', '')]);
      expect(hang).toMatchObject({ parseStatus: 'failed', failureReason: 'PARSE_TIMEOUT' });
      expect(ok.parseStatus).toBe('parsed');
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(pool.stats).toMatchObject({ timeouts: 1, restarts: 1 });
    } finally {
      await pool.close();
    }
  });

  it('leaves no runaway process after a timeout', async () => {
    const pool = new ParserPool({ workers: 1, deadlineMs: 300, workerPath: hostile });
    try {
      const pids: number[] = [];
      const internals = pool as unknown as { slots: { child: { pid?: number } | null }[] };
      const pending = pool.parse('pid.ts', '');
      await new Promise((r) => setTimeout(r, 150));
      const pid = internals.slots[0]!.child?.pid;
      if (pid) pids.push(pid);
      expect(await pending).toMatchObject({ failureReason: 'PARSE_TIMEOUT' });
      await new Promise((r) => setTimeout(r, 500));
      expect(pids).toHaveLength(1);
      expect(alive(pids[0]!)).toBe(false);
    } finally {
      await pool.close();
    }
  });

  it('contains a crash and a heap exhaustion as failed parses', async () => {
    const pool = new ParserPool({ workers: 2, deadlineMs: 20_000, heapMiB: 64, workerPath: hostile });
    try {
      const [crash, oom, ok] = await Promise.all([pool.parse('crash.ts', ''), pool.parse('oom.ts', ''), pool.parse('ok.ts', '')]);
      expect(crash).toMatchObject({ parseStatus: 'failed', failureReason: 'PARSER_CRASHED' });
      expect(oom).toMatchObject({ parseStatus: 'failed', failureReason: 'PARSER_CRASHED' });
      expect(ok.parseStatus).toBe('parsed');
      expect(pool.stats.crashes).toBe(2);
    } finally {
      await pool.close();
    }
  });
});

describe('fact cache', () => {
  const work = mkdtempSync(path.join(tmpdir(), 'atlas-facts-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const text = 'export const a = 1;\n';
  const blob = sha256Hex(text);

  it('keys on content, script family, parser and extractor versions', () => {
    expect(factCacheKey('a.ts', blob)).toBe(factCacheKey('other/b.mts', blob));
    expect(factCacheKey('a.ts', blob)).not.toBe(factCacheKey('a.tsx', blob));
    expect(factCacheKey('a.ts', blob)).not.toBe(factCacheKey('a.ts', sha256Hex('export const a = 2;\n')));
  });

  it('never caches environmental failures', () => {
    expect(isCacheable(failedFacts('a.ts', text, 'PARSE_TIMEOUT'))).toBe(false);
    expect(isCacheable(failedFacts('a.ts', text, 'PARSER_CRASHED'))).toBe(false);
    expect(isCacheable(failedFacts('a.ts', text, 'SYNTAX_ERROR'))).toBe(true);
  });

  it('round-trips through disk and rejects tampered entries', async () => {
    const key = factCacheKey('a.ts', blob);
    const facts = extractFileFacts('a.ts', text);
    await new DirectoryFactCache(work).set(key, facts);
    const fresh = new DirectoryFactCache(work);
    expect(await fresh.get(key)).toEqual(facts);
    const file = path.join(work, key.slice(0, 2), `${key}.json`);
    const entry = JSON.parse(await import('node:fs/promises').then((f) => f.readFile(file, 'utf8')));
    entry.facts.codeLines = 999;
    writeFileSync(file, JSON.stringify(entry));
    const tampered = new DirectoryFactCache(work);
    expect(await tampered.get(key)).toBeNull();
    expect(tampered.stats.rejected).toBe(1);
    expect(readdirSync(path.dirname(file)).filter((f) => f.endsWith('.json'))).toEqual([]);
  });

  it('counts hits and misses in memory', async () => {
    const cache = new MemoryFactCache();
    await cache.get('x');
    await cache.set('x', extractFileFacts('a.ts', text));
    await cache.get('x');
    expect(cache.stats).toMatchObject({ hits: 1, misses: 1 });
  });
});
