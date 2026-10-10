import { LIMITS, compareUtf8, isWithinRepoPath, repoBasename, repoDirname, type DeclaredRange } from '@atlas/schema';
import type { SnapshotFS } from './vfs.js';

/**
 * Package manifests and the virtual workspace map (plan §9.3). Manifests are parsed as
 * inert JSON; no install, script or package-manager logic ever runs.
 */
export type DependencyField = DeclaredRange['field'];
export const DEPENDENCY_FIELDS: readonly DependencyField[] = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

export interface PackageManifest {
  /** Directory containing package.json ('' for the repository root). */
  root: string;
  manifestPath: string;
  name: string | null;
  type: 'module' | 'commonjs' | null;
  workspace: boolean;
  /** Raw JSON fields used for entry-point fallback (exports/imports/main/types/module). */
  entryFields: { exports: unknown; types: string | null; module: string | null; main: string | null };
  dependencies: Map<string, { field: DependencyField; range: string }[]>;
}

export interface WorkspaceWarning {
  code: string;
  path: string | null;
}

export interface WorkspaceMap {
  manifests: PackageManifest[];
  /** Workspace package name -> manifest (members and a named root). */
  byName: Map<string, PackageManifest>;
  /** Directories of recognized package roots, deepest first, for nearest-package lookup. */
  packageRoots: string[];
  usesWorkspaces: boolean;
  warnings: WorkspaceWarning[];
}

function parseJsonObject(text: string | null): Record<string, unknown> | null {
  if (text === null || text.length > LIMITS.configFileBytes) return null;
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length <= 1024 ? v : null);

/** Bounded reader for `packages:` in pnpm-workspace.yaml (block or flow sequence). */
export function parsePnpmWorkspacePackages(text: string): string[] {
  const out: string[] = [];
  const lines = text.split(/\r?\n/).slice(0, 2_000);
  for (let i = 0; i < lines.length; i++) {
    const header = /^packages\s*:\s*(.*)$/.exec(lines[i]!);
    if (!header) continue;
    const inline = header[1]!.replace(/#.*$/, '').trim();
    if (inline.startsWith('[')) {
      for (const item of inline.replace(/^\[|\]$/g, '').split(',')) {
        const value = item.trim().replace(/^['"]|['"]$/g, '');
        if (value) out.push(value);
      }
      return out;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      const item = /^\s+-\s*(['"]?)(.+?)\1\s*(?:#.*)?$/.exec(line);
      if (!item) break;
      out.push(item[2]!);
    }
    return out;
  }
  return out;
}

/** Workspace globs: `*` within a segment, `**` across segments; leading `!` negates. */
export function workspaceGlobToRegExp(glob: string): RegExp | null {
  const cleaned = glob.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '' || cleaned.includes('..') || cleaned.startsWith('/')) return null;
  let pattern = '';
  const segments = cleaned.split('/');
  segments.forEach((segment, index) => {
    if (segment === '**') pattern += index === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
    else {
      pattern += segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*').replaceAll('?', '[^/]');
      if (index < segments.length - 1) pattern += '/';
    }
  });
  return new RegExp(`^${pattern.replace(/\/$/, '')}$`);
}

export function discoverWorkspace(fs: SnapshotFS): WorkspaceMap {
  const warnings: WorkspaceWarning[] = [];
  const manifestPaths = fs.paths().filter((p) => repoBasename(p) === 'package.json');
  const root = parseJsonObject(fs.readText('package.json'));
  const globs: string[] = [];
  const workspacesField = root?.['workspaces'];
  if (Array.isArray(workspacesField)) globs.push(...workspacesField.filter((g): g is string => typeof g === 'string'));
  else if (workspacesField && typeof workspacesField === 'object') {
    const packages = (workspacesField as Record<string, unknown>)['packages'];
    if (Array.isArray(packages)) globs.push(...packages.filter((g): g is string => typeof g === 'string'));
  }
  const pnpm = fs.readText('pnpm-workspace.yaml');
  if (pnpm !== null) globs.push(...parsePnpmWorkspacePackages(pnpm.slice(0, LIMITS.configFileBytes)));
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const glob of globs.slice(0, 256)) {
    const negated = glob.startsWith('!');
    const re = workspaceGlobToRegExp(negated ? glob.slice(1) : glob);
    if (!re) warnings.push({ code: 'WORKSPACE_GLOB_UNSUPPORTED', path: null });
    else (negated ? exclude : include).push(re);
  }
  const usesWorkspaces = include.length > 0;

  const manifests: PackageManifest[] = [];
  for (const manifestPath of manifestPaths) {
    const dir = repoDirname(manifestPath);
    const json = parseJsonObject(fs.readText(manifestPath));
    if (!json) {
      warnings.push({ code: 'MANIFEST_UNREADABLE', path: manifestPath });
      continue;
    }
    const member = dir === '' || (include.some((re) => re.test(dir)) && !exclude.some((re) => re.test(dir)));
    const dependencies = new Map<string, { field: DependencyField; range: string }[]>();
    for (const field of DEPENDENCY_FIELDS) {
      const deps = json[field];
      if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
      for (const [name, range] of Object.entries(deps as Record<string, unknown>).slice(0, 2_000)) {
        if (typeof range !== 'string') continue;
        const list = dependencies.get(name) ?? [];
        list.push({ field, range: range.slice(0, 256) });
        dependencies.set(name, list);
      }
    }
    const type = json['type'];
    manifests.push({
      root: dir,
      manifestPath,
      name: str(json['name']),
      type: type === 'module' || type === 'commonjs' ? type : null,
      workspace: member && (dir !== '' || usesWorkspaces),
      entryFields: { exports: json['exports'] ?? null, types: str(json['types']) ?? str(json['typings']), module: str(json['module']), main: str(json['main']) },
      dependencies,
    });
  }

  const byName = new Map<string, PackageManifest>();
  for (const manifest of manifests) {
    if (!manifest.name || !(manifest.workspace || manifest.root === '')) continue;
    if (byName.has(manifest.name)) {
      warnings.push({ code: 'DUPLICATE_WORKSPACE_PACKAGE_NAME', path: manifest.manifestPath });
      continue;
    }
    byName.set(manifest.name, manifest);
  }
  const packageRoots = manifests
    .filter((m) => m.workspace || m.root === '')
    .map((m) => m.root)
    .sort((a, b) => b.length - a.length || compareUtf8(a, b));
  return { manifests, byName, packageRoots, usesWorkspaces, warnings };
}

/** The nearest manifest at or above a file (any package.json, workspace member or not). */
export function nearestManifest(map: WorkspaceMap, path: string): PackageManifest | null {
  let best: PackageManifest | null = null;
  for (const manifest of map.manifests) {
    if (isWithinRepoPath(repoDirname(path), manifest.root) && (best === null || manifest.root.length > best.root.length)) best = manifest;
  }
  return best;
}

/** Valid npm package name at the start of a bare specifier, or null. */
export function packageNameOf(specifier: string): string | null {
  const segments = specifier.split('/');
  const name = specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!;
  if (name.length === 0 || name.length > 214) return null;
  const part = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
  if (name.startsWith('@')) {
    const [scope, pkg] = name.slice(1).split('/');
    return scope && pkg && part.test(scope) && part.test(pkg) ? name : null;
  }
  return part.test(name) ? name : null;
}
