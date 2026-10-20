import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTRACTOR_VERSION, PARSER_VERSION } from '@atlas/analyzer-ts';
import { PYTHON_EXTRACTOR_VERSION, PYTHON_PARSER_VERSION, isPythonSourcePath } from '@atlas/analyzer-py';
import type { SyntaxFacts as FileFacts } from './facts.js';
import { canonicalJson, repoExtension, sha256Hex } from '@atlas/schema';

/**
 * Content-addressed syntax-fact cache (plan §9.4). The key is the blob's SHA-256 plus the
 * script kind, parser version and extraction version, so facts are reused across paths,
 * frames and runs, never across parser or rule changes. Entries hold plain facts only and
 * are verified on read; a corrupt entry is discarded, never trusted.
 */
export interface FactCache {
  get(key: string): Promise<FileFacts | null>;
  set(key: string, facts: FileFacts): Promise<void>;
  readonly stats: { hits: number; misses: number; rejected: number };
}

/** Script-kind family for keys: content parses identically within a family. */
function scriptFamily(filePath: string): string {
  const ext = repoExtension(filePath);
  if (ext === '.tsx') return 'tsx';
  if (ext === '.jsx' || ext === '.js' || ext === '.mjs' || ext === '.cjs') return 'js';
  return 'ts';
}

export function factCacheKey(filePath: string, blobSha256: string): string {
  // Python facts are keyed by the Python parser and extractor (ADR-060); TS/JS keys are unchanged.
  if (isPythonSourcePath(filePath)) return sha256Hex(`atlas.facts/1\0${PYTHON_PARSER_VERSION}\0${PYTHON_EXTRACTOR_VERSION}\0${repoExtension(filePath) === '.pyi' ? 'pyi' : 'py'}\0${blobSha256}`);
  return sha256Hex(`atlas.facts/1\0${PARSER_VERSION}\0${EXTRACTOR_VERSION}\0${scriptFamily(filePath)}\0${blobSha256}`);
}

/**
 * Failed parses caused by the environment (deadline, crashed child) are not cached: a
 * later run with more headroom must be able to succeed. Syntax errors are content facts.
 */
export function isCacheable(facts: FileFacts): boolean {
  return facts.failureReason !== 'PARSE_TIMEOUT' && facts.failureReason !== 'PARSER_CRASHED';
}

export class MemoryFactCache implements FactCache {
  private readonly entries = new Map<string, FileFacts>();
  readonly stats = { hits: 0, misses: 0, rejected: 0 };
  async get(key: string) {
    const hit = this.entries.get(key) ?? null;
    if (hit) this.stats.hits++;
    else this.stats.misses++;
    return hit;
  }
  async set(key: string, facts: FileFacts) {
    if (isCacheable(facts)) this.entries.set(key, facts);
  }
}

/**
 * One analysis' own fact cache (ADR-084). Frames are analyzed newest first, and a frame
 * shares its blobs with the frame analyzed just before it; a blob that frame did not have
 * returns only if a file goes back to earlier content. So, at each `advance()`, entries
 * that neither the frame just finished nor the one before it used are released, instead of
 * holding the facts of every blob in the window. A released entry that is needed again is
 * parsed again, with the same facts.
 */
export class FrameFactCache implements FactCache {
  private previous = new Map<string, FileFacts>();
  private current = new Map<string, FileFacts>();
  readonly stats = { hits: 0, misses: 0, rejected: 0 };
  async get(key: string) {
    let hit = this.current.get(key) ?? null;
    if (!hit) {
      hit = this.previous.get(key) ?? null;
      if (hit) this.current.set(key, hit);
    }
    if (hit) this.stats.hits++;
    else this.stats.misses++;
    return hit;
  }
  async set(key: string, facts: FileFacts) {
    if (isCacheable(facts)) this.current.set(key, facts);
  }
  /** A frame is finished: keep what it used, release what only older generations used. */
  advance(): void {
    this.previous = this.current;
    this.current = new Map();
  }
}

interface StoredEntry {
  format: 'atlas.fact-cache/1';
  key: string;
  sha256: string;
  facts: FileFacts;
}

/** A local on-disk cache under a caller-chosen directory (never uploaded anywhere). */
export class DirectoryFactCache implements FactCache {
  private readonly memory = new MemoryFactCache();
  readonly stats = { hits: 0, misses: 0, rejected: 0 };
  constructor(private readonly dir: string) {}

  private file(key: string): string {
    if (!/^[0-9a-f]{64}$/.test(key)) throw new TypeError('Invalid fact cache key');
    return path.join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<FileFacts | null> {
    const inMemory = await this.memory.get(key);
    if (inMemory) {
      this.stats.hits++;
      return inMemory;
    }
    try {
      const entry = JSON.parse(await readFile(this.file(key), 'utf8')) as StoredEntry;
      if (entry.format !== 'atlas.fact-cache/1' || entry.key !== key || sha256Hex(canonicalJson(entry.facts)) !== entry.sha256) {
        this.stats.rejected++;
        await rm(this.file(key), { force: true });
        this.stats.misses++;
        return null;
      }
      await this.memory.set(key, entry.facts);
      this.stats.hits++;
      return entry.facts;
    } catch {
      this.stats.misses++;
      return null;
    }
  }

  async set(key: string, facts: FileFacts): Promise<void> {
    if (!isCacheable(facts)) return;
    await this.memory.set(key, facts);
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    const entry: StoredEntry = { format: 'atlas.fact-cache/1', key, sha256: sha256Hex(canonicalJson(facts)), facts };
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(entry));
    await rename(temp, file).catch(async () => rm(temp, { force: true }));
  }
}
