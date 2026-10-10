import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EXTRACTOR_VERSION, PARSER_VERSION, type FileFacts } from '@atlas/analyzer-ts';
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
