import { matchFiles, type FileSystemEntries } from './internal.js';
import { fromVirtual, toVirtual, VIRTUAL_ROOT, type SnapshotFS } from './vfs.js';
import { packageNameOf, type WorkspaceMap } from './workspace.js';

/**
 * A TypeScript host whose every operation reads the virtual snapshot (plan §9.3). Bare
 * workspace package names are exposed through a virtual `/repo/node_modules/<name>`
 * mapping that points at the package's committed source root — never at a physical
 * `node_modules`, which ATLAS does not read or install.
 */
export interface VirtualHost {
  useCaseSensitiveFileNames: boolean;
  getCurrentDirectory(): string;
  fileExists(path: string): boolean;
  readFile(path: string): string | undefined;
  directoryExists(path: string): boolean;
  getDirectories(path: string): string[];
  readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): string[];
  realpath(path: string): string;
  /** True when `virtualPath` was reached through the workspace node_modules mapping. */
  isWorkspaceMapped(virtualPath: string): boolean;
  repoPathOf(virtualPath: string): string | null;
}

interface Mapped {
  repoPath: string;
  viaWorkspace: boolean;
}

export function createVirtualHost(fs: SnapshotFS, workspace: WorkspaceMap): VirtualHost {
  const scopes = new Set<string>();
  for (const name of workspace.byName.keys()) if (name.startsWith('@')) scopes.add(name.split('/')[0]!);

  const map = (virtualPath: string): Mapped | null => {
    const repoPath = fromVirtual(virtualPath);
    if (repoPath === null) return null;
    if (repoPath === 'node_modules' || repoPath.startsWith('node_modules/')) {
      const rest = repoPath.slice('node_modules/'.length);
      const name = packageNameOf(rest);
      const manifest = name ? workspace.byName.get(name) : undefined;
      if (!name || !manifest) return null;
      const inner = rest.slice(name.length).replace(/^\//, '');
      const target = [manifest.root, inner].filter((s) => s !== '').join('/');
      return { repoPath: target, viaWorkspace: true };
    }
    return { repoPath, viaWorkspace: false };
  };

  const isVirtualScopeDir = (virtualPath: string): boolean => {
    const repoPath = fromVirtual(virtualPath);
    if (repoPath === 'node_modules') return workspace.byName.size > 0;
    if (repoPath?.startsWith('node_modules/')) return scopes.has(repoPath.slice('node_modules/'.length));
    return false;
  };

  const getFileSystemEntries = (virtualPath: string): FileSystemEntries => {
    const mapped = map(virtualPath);
    if (!mapped) return { files: [], directories: [] };
    return fs.list(mapped.repoPath);
  };

  const host: VirtualHost = {
    useCaseSensitiveFileNames: true,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    fileExists: (p) => {
      const mapped = map(p);
      return mapped !== null && fs.hasFile(mapped.repoPath);
    },
    readFile: (p) => {
      const mapped = map(p);
      return mapped ? (fs.readText(mapped.repoPath) ?? undefined) : undefined;
    },
    directoryExists: (p) => {
      if (isVirtualScopeDir(p)) return true;
      const mapped = map(p);
      return mapped !== null && fs.hasDirectory(mapped.repoPath);
    },
    getDirectories: (p) => getFileSystemEntries(p).directories.slice(),
    realpath: (p) => {
      const mapped = map(p);
      return mapped ? toVirtual(mapped.repoPath) : p;
    },
    readDirectory: (rootDir, extensions, excludes, includes, depth) => {
      // TypeScript's own include/exclude glob engine, over virtual entries only.
      return matchFiles(rootDir, extensions, excludes, includes, true, VIRTUAL_ROOT, depth, getFileSystemEntries, (p) => p);
    },
    isWorkspaceMapped: (p) => map(p)?.viaWorkspace ?? false,
    repoPathOf: (p) => map(p)?.repoPath ?? null,
  };
  return host;
}
