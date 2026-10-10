import { batchCheck, decodeStrictUtf8, listTree, readObjects, type SafeGit, type TreeEntry } from '@atlas/ingest';
import { checkRepoPath, compareUtf8, sha256Hex, type FileRole } from '@atlas/schema';
import {
  LFS_POINTER_PREFIX,
  builtinExclusions,
  classifyPath,
  firstMatchingRule,
  hasFlowPragma,
  hasGeneratedHeader,
  type ExclusionRule,
} from './classify.js';
import { compileGlob } from './globs.js';
import type { EffectiveLimits } from './options.js';
import { AnalysisError } from './errors.js';

/**
 * Safe committed inventory (task P1.2, plan §4.3, §8.5). Enumerates one commit's tree in
 * canonical UTF-8 byte order and accounts for every entry exactly once: included (as a
 * supported or opaque file), excluded (with a reason) or omitted by a limit.
 */
export interface InventoryFile {
  path: string;
  blobOid: string;
  blobSha256: string | null;
  byteSize: number;
  role: FileRole;
  language: 'typescript' | 'javascript' | null;
  /** True for TS/JS files whose content passed every check: Phase 2 parses these. */
  supported: boolean;
  /** Why an included file is opaque, when it is not simply a non-code file. */
  opaqueReason: string | null;
  /** Decoded text for supported files and recognized configuration, else null. */
  text: string | null;
}

export interface InventoryExclusion {
  path: string | null;
  reason: string;
}

export interface Inventory {
  files: InventoryFile[];
  /** Excluded paths (path null when the path itself is unrepresentable). */
  excluded: InventoryExclusion[];
  omitted: string[];
  discovered: number;
  reasons: Map<string, number>;
  limitsHit: Set<string>;
  /** Exclusion roots worth naming in reports, e.g. `node_modules` with its file count. */
  excludedRoots: Map<string, { reason: string; count: number }>;
  decodedSourceBytes: number;
}

export interface InventoryOptions {
  limits: EffectiveLimits;
  /** Repository-config and CLI patterns, applied after the built-in rules. */
  repositoryExclude: readonly string[];
  cliExclude: readonly string[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

const BATCH_FILES = 512;
const BATCH_BYTES = 16 * 1024 * 1024;
const LFS_PROBE_BYTES = 1024;

function rawCompare(a: TreeEntry, b: TreeEntry): number {
  return Buffer.compare(a.rawPath, b.rawPath);
}

/** The shallowest excluded directory (or the file itself) for reporting. */
function exclusionRoot(path: string, rule: ExclusionRule): string {
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i++) {
    const prefix = segments.slice(0, i).join('/');
    // A directory is excluded as a whole when anything beneath it would match.
    if (rule.glob.test(`${prefix}/\u0000probe`)) return prefix;
  }
  return path;
}

export async function buildInventory(git: SafeGit, treeOid: string, options: InventoryOptions): Promise<Inventory> {
  const listing = await listTree(git, treeOid, { maxEntries: options.limits.treeEntries, ...(options.signal ? { signal: options.signal } : {}) });
  if (listing.truncated) {
    throw new AnalysisError('ANALYSIS_RESOURCE_LIMIT', `The tree has more than ${options.limits.treeEntries.toLocaleString('en-US')} entries`, { limit: 'TREE_ENTRY_LIMIT' });
  }
  const entries = [...listing.entries].sort(rawCompare);
  const rules: ExclusionRule[] = [
    ...builtinExclusions(),
    ...options.repositoryExclude.map((p) => ({ reason: 'REPOSITORY_EXCLUDED', glob: compileGlob(p)!, source: 'repository-config' as const })),
    ...options.cliExclude.map((p) => ({ reason: 'CLI_EXCLUDED', glob: compileGlob(p)!, source: 'cli' as const })),
  ];

  const inventory: Inventory = {
    files: [],
    excluded: [],
    omitted: [],
    discovered: entries.length,
    reasons: new Map(),
    limitsHit: new Set(),
    excludedRoots: new Map(),
    decodedSourceBytes: 0,
  };
  const count = (reason: string) => inventory.reasons.set(reason, (inventory.reasons.get(reason) ?? 0) + 1);
  const exclude = (path: string | null, reason: string) => {
    inventory.excluded.push({ path, reason });
    count(reason);
  };

  // Pass 1: path validity, entry kind and scope rules. No content is read.
  const candidates: { entry: TreeEntry; path: string }[] = [];
  for (const entry of entries) {
    if (entry.path === null) {
      exclude(null, 'INVALID_UTF8_PATH');
      continue;
    }
    const check = checkRepoPath(entry.path);
    if (!check.ok) {
      exclude(null, `INVALID_PATH_${check.reason}`);
      continue;
    }
    if (entry.kind === 'symlink') exclude(entry.path, 'SYMLINK');
    else if (entry.kind === 'submodule') exclude(entry.path, 'SUBMODULE');
    else if (entry.kind !== 'blob') exclude(entry.path, 'UNSUPPORTED_ENTRY');
    else {
      const rule = firstMatchingRule(entry.path, rules);
      if (rule) {
        exclude(entry.path, rule.reason);
        const root = exclusionRoot(entry.path, rule);
        const current = inventory.excludedRoots.get(root);
        inventory.excludedRoots.set(root, { reason: rule.reason, count: (current?.count ?? 0) + 1 });
      } else candidates.push({ entry, path: entry.path });
    }
  }

  // Pass 2: content checks in canonical order, in bounded batches, until the file cap.
  let index = 0;
  while (index < candidates.length) {
    if (options.signal?.aborted) throw new AnalysisError('CANCELLED', 'Analysis cancelled');
    if (inventory.files.length >= options.limits.includedFiles) {
      for (; index < candidates.length; index++) {
        inventory.omitted.push(candidates[index]!.path);
        count('FILE_LIMIT');
      }
      inventory.limitsHit.add('FILE_LIMIT');
      break;
    }
    const batch: { entry: TreeEntry; path: string }[] = [];
    let batchBytes = 0;
    const room = options.limits.includedFiles - inventory.files.length;
    while (index < candidates.length && batch.length < Math.min(BATCH_FILES, room) && batchBytes < BATCH_BYTES) {
      const candidate = candidates[index++]!;
      batch.push(candidate);
      batchBytes += Math.min(candidate.entry.size ?? 0, options.limits.sourceBlobBytes);
    }
    await classifyBatch(git, batch, inventory, options, count, exclude);
    options.onProgress?.(index, candidates.length);
  }
  inventory.files.sort((a, b) => compareUtf8(a.path, b.path));
  return inventory;
}

async function classifyBatch(
  git: SafeGit,
  batch: readonly { entry: TreeEntry; path: string }[],
  inventory: Inventory,
  options: InventoryOptions,
  count: (reason: string) => void,
  exclude: (path: string, reason: string) => void,
): Promise<void> {
  const classes = batch.map((c) => classifyPath(c.path));
  // Content is needed for code and recognized config within the blob cap, and for any
  // small blob (LFS pointer detection).
  const wanted = batch
    .map((c, i) => ({ c, cls: classes[i]! }))
    .filter(({ c, cls }) => {
      const size = c.entry.size ?? Number.MAX_SAFE_INTEGER;
      // Lockfiles are structural only: their content is never needed.
      if (cls.lockfile) return false;
      return ((cls.code || cls.config) && size <= options.limits.sourceBlobBytes) || size <= LFS_PROBE_BYTES;
    })
    .map(({ c }) => ({ oid: c.entry.oid, size: c.entry.size! }));
  const unique = [...new Map(wanted.map((w) => [w.oid, w])).values()];
  if (unique.some((w) => !Number.isSafeInteger(w.size))) {
    const infos = await batchCheck(git, unique.map((w) => w.oid), options.signal);
    infos.forEach((info, i) => (unique[i]!.size = info.size ?? 0));
  }
  const contents = await readObjects(git, unique, options.signal);

  batch.forEach(({ entry, path }, i) => {
    const cls = classes[i]!;
    const bytes = contents.get(entry.oid)?.bytes ?? null;
    const size = entry.size ?? bytes?.length ?? 0;
    const file: InventoryFile = {
      path,
      blobOid: entry.oid,
      blobSha256: bytes ? sha256Hex(bytes) : null,
      byteSize: size,
      role: cls.role,
      language: cls.language,
      supported: false,
      opaqueReason: null,
      text: null,
    };
    const opaque = (reason: string) => {
      file.opaqueReason = reason;
      count(reason);
    };

    if (cls.lockfile) {
      count('LOCKFILE_STRUCTURAL');
    } else if (bytes && bytes.length <= LFS_PROBE_BYTES && bytes.subarray(0, LFS_POINTER_PREFIX.length).toString('latin1') === LFS_POINTER_PREFIX) {
      opaque('LFS_NOT_FETCHED');
    } else if ((cls.code || cls.config) && size > options.limits.sourceBlobBytes) {
      opaque('OVERSIZE');
    } else if (cls.code || cls.config) {
      const text = bytes ? decodeText(bytes) : null;
      if (bytes && bytes.subarray(0, 8000).includes(0)) opaque('BINARY_CONTENT');
      else if (text === null) opaque('INVALID_ENCODING');
      else if (cls.code && hasGeneratedHeader(text)) {
        exclude(path, 'GENERATED_HEADER');
        return;
      } else if (cls.code && hasFlowPragma(text)) opaque('FLOW_UNSUPPORTED');
      else if (cls.code && inventory.decodedSourceBytes + bytes!.length > options.limits.headDecodedSourceBytes) {
        opaque('SOURCE_BUDGET');
        inventory.limitsHit.add('SOURCE_BUDGET');
      } else {
        file.text = text;
        if (cls.code) {
          file.supported = true;
          inventory.decodedSourceBytes += bytes!.length;
        }
      }
    } else if (cls.unsupportedLanguage) {
      count('LANGUAGE_UNSUPPORTED');
    }
    inventory.files.push(file);
  });
}

function decodeText(bytes: Uint8Array): string | null {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  return decodeStrictUtf8(body);
}

