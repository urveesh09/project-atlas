import { compareUtf8, repoDirname } from '@atlas/schema';

/**
 * A read-only virtual view of one committed snapshot (plan §5.4 `ReadonlySnapshotFS`).
 * There is no host fallback: anything not indexed here does not exist. Paths handed to
 * the TypeScript compiler are rooted at `/repo` so they can never alias host paths.
 */
export const VIRTUAL_ROOT = '/repo';

export interface SnapshotEntry {
  path: string;
  /** Decoded UTF-8 text, or null when the file is binary, oversized or not loaded. */
  text: string | null;
}

export class SnapshotFS {
  private readonly files = new Map<string, string | null>();
  private readonly lowerIndex = new Map<string, string[]>();
  private readonly directories = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  private readonly excluded = new Set<string>();

  constructor(entries: Iterable<SnapshotEntry>, excludedPaths: Iterable<string> = []) {
    this.directories.set('', { files: new Set(), dirs: new Set() });
    for (const entry of entries) {
      this.files.set(entry.path, entry.text);
      const lower = entry.path.toLowerCase();
      const bucket = this.lowerIndex.get(lower) ?? [];
      bucket.push(entry.path);
      this.lowerIndex.set(lower, bucket);
      this.index(entry.path);
    }
    for (const path of excludedPaths) this.excluded.add(path);
  }

  private index(path: string): void {
    let child = path;
    let parent = repoDirname(path);
    let isFile = true;
    for (;;) {
      let dir = this.directories.get(parent);
      const existed = dir !== undefined;
      if (!dir) {
        dir = { files: new Set(), dirs: new Set() };
        this.directories.set(parent, dir);
      }
      (isFile ? dir.files : dir.dirs).add(parent === '' ? child : child.slice(parent.length + 1));
      // An existing directory is already linked to all of its ancestors.
      if (existed || parent === '') break;
      child = parent;
      parent = repoDirname(parent);
      isFile = false;
    }
  }

  get size(): number {
    return this.files.size;
  }

  paths(): string[] {
    return [...this.files.keys()].sort(compareUtf8);
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  readText(path: string): string | null {
    return this.files.get(path) ?? null;
  }

  hasDirectory(path: string): boolean {
    return this.directories.has(path);
  }

  list(path: string): { files: string[]; directories: string[] } {
    const dir = this.directories.get(path);
    if (!dir) return { files: [], directories: [] };
    return { files: [...dir.files].sort(compareUtf8), directories: [...dir.dirs].sort(compareUtf8) };
  }

  isExcluded(path: string): boolean {
    return this.excluded.has(path);
  }

  /** Paths that differ from `path` only by case (for CASE_MISMATCH reporting). */
  caseVariants(path: string): string[] {
    return (this.lowerIndex.get(path.toLowerCase()) ?? []).filter((p) => p !== path);
  }
}

export function toVirtual(repoPath: string): string {
  return repoPath === '' ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${repoPath}`;
}

/** Map a virtual path back to a repository path, or null if it is outside the snapshot. */
export function fromVirtual(virtualPath: string): string | null {
  const normalized = virtualPath.replaceAll('\\', '/');
  if (normalized === VIRTUAL_ROOT) return '';
  if (!normalized.startsWith(`${VIRTUAL_ROOT}/`)) return null;
  const rest = normalized.slice(VIRTUAL_ROOT.length + 1);
  const segments: string[] = [];
  for (const segment of rest.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.join('/');
}
