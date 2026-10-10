import ts from 'typescript';
import { LIMITS, compareUtf8, isWithinRepoPath, repoBasename, repoDirname, repoExtension } from '@atlas/schema';
import type { VirtualHost } from './host.js';
import { getEmitModuleResolutionKind } from './internal.js';
import { fromVirtual, toVirtual, VIRTUAL_ROOT, type SnapshotFS } from './vfs.js';
import { nearestManifest, type WorkspaceMap } from './workspace.js';

/**
 * Project contexts from tsconfig/jsconfig files (plan §9.3). Configs are read as JSONC
 * through the virtual host; `extends` chains are pre-walked with explicit depth, count,
 * cycle and containment limits; plugins are never loaded.
 */
export type ResolverKind = 'classic' | 'node10' | 'node16' | 'nodenext' | 'bundler';

export interface ProjectContext {
  /** Config path, or `inferred:<kind>` for the documented no-config defaults. */
  id: string;
  configPath: string | null;
  options: ts.CompilerOptions;
  resolverKind: ResolverKind;
  /** Repository paths this config includes (empty for inferred contexts). */
  files: ReadonlySet<string>;
  /** Reason the context is known to be incomplete (e.g. package `extends`). */
  incomplete: string | null;
  outDir: string | null;
  rootDir: string | null;
  references: string[];
  cache: ts.ModuleResolutionCache;
}

export interface ConfigWarning {
  code: string;
  path: string | null;
}

export interface ProjectSet {
  contexts: ProjectContext[];
  warnings: ConfigWarning[];
  /** Pick the context for a source file and how it was chosen. */
  contextFor(path: string): { context: ProjectContext; selection: 'included' | 'ancestor' | 'inferred' };
}

const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);
const IGNORED_CONFIG_ERRORS = new Set([18003, 6053, 5101, 5107, 5108, 5110, 5102]);

export function resolverKindOf(options: ts.CompilerOptions): ResolverKind {
  switch (getEmitModuleResolutionKind(options)) {
    case ts.ModuleResolutionKind.Classic:
      return 'classic';
    case ts.ModuleResolutionKind.Node16:
      return 'node16';
    case ts.ModuleResolutionKind.NodeNext:
      return 'nodenext';
    case ts.ModuleResolutionKind.Bundler:
      return 'bundler';
    default:
      return 'node10';
  }
}

function joinRepo(base: string, relative: string): string | null {
  return fromVirtual(`${toVirtual(base)}/${relative}`);
}

type ExtendsCheck = { usable: true; external: boolean } | { usable: false; code: string };

function checkExtends(fs: SnapshotFS, configPath: string, depth: number, seen: Set<string>, budget: { configs: number }): ExtendsCheck {
  if (depth > LIMITS.configInheritanceDepth) return { usable: false, code: 'CONFIG_EXTENDS_TOO_DEEP' };
  if (seen.has(configPath)) return { usable: false, code: 'CONFIG_EXTENDS_CYCLE' };
  if (++budget.configs > LIMITS.configFiles) return { usable: false, code: 'CONFIG_LIMIT' };
  const text = fs.readText(configPath);
  if (text === null) return { usable: false, code: 'CONFIG_EXTENDS_MISSING' };
  if (text.length > LIMITS.configFileBytes) return { usable: false, code: 'CONFIG_TOO_LARGE' };
  const { config } = ts.parseConfigFileTextToJson(toVirtual(configPath), text);
  const raw: unknown = config?.extends;
  const list = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  let external = false;
  const nextSeen = new Set(seen).add(configPath);
  for (const entry of list) {
    if (!entry.startsWith('./') && !entry.startsWith('../') && !entry.startsWith('/')) {
      external = true;
      continue;
    }
    if (entry.startsWith('/')) return { usable: false, code: 'CONFIG_EXTENDS_ESCAPES' };
    let target = joinRepo(repoDirname(configPath), entry);
    if (target === null || target === '') return { usable: false, code: 'CONFIG_EXTENDS_ESCAPES' };
    if (!fs.hasFile(target) && fs.hasFile(`${target}.json`)) target = `${target}.json`;
    const nested = checkExtends(fs, target, depth + 1, nextSeen, budget);
    if (!nested.usable) return nested;
    external ||= nested.external;
  }
  return { usable: true, external };
}

function inferredContext(kind: 'bundler' | 'nodenext', host: VirtualHost): ProjectContext {
  const options: ts.CompilerOptions =
    kind === 'bundler'
      ? { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, resolveJsonModule: true, allowImportingTsExtensions: true, noEmit: true }
      : { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true, resolveJsonModule: true, noEmit: true };
  return {
    id: `inferred:${kind}`,
    configPath: null,
    options,
    resolverKind: kind,
    files: new Set(),
    incomplete: null,
    outDir: null,
    rootDir: null,
    references: [],
    cache: ts.createModuleResolutionCache(VIRTUAL_ROOT, (f) => f, options),
  };
}

export function discoverProjects(fs: SnapshotFS, host: VirtualHost, workspace: WorkspaceMap): ProjectSet {
  const warnings: ConfigWarning[] = [];
  const queue = fs.paths().filter((p) => CONFIG_NAMES.has(repoBasename(p)));
  const visited = new Set<string>();
  const contexts: ProjectContext[] = [];

  while (queue.length > 0 && visited.size < LIMITS.configFiles) {
    const configPath = queue.shift()!;
    if (visited.has(configPath)) continue;
    visited.add(configPath);
    const check = checkExtends(fs, configPath, 0, new Set(), { configs: 0 });
    if (!check.usable) {
      warnings.push({ code: check.code, path: configPath });
      continue;
    }
    const text = fs.readText(configPath)!;
    const virtual = toVirtual(configPath);
    const { config, error } = ts.parseConfigFileTextToJson(virtual, text);
    if (error || !config || typeof config !== 'object') {
      warnings.push({ code: 'CONFIG_PARSE_ERROR', path: configPath });
      continue;
    }
    // Plugins are configuration for executable language-service code; never honored.
    if (config.compilerOptions && typeof config.compilerOptions === 'object' && 'plugins' in config.compilerOptions) {
      delete config.compilerOptions.plugins;
      warnings.push({ code: 'CONFIG_PLUGINS_IGNORED', path: configPath });
    }
    const parsed = ts.parseJsonConfigFileContent(config, host, toVirtual(repoDirname(configPath)), undefined, virtual);
    if (parsed.errors.some((e) => !IGNORED_CONFIG_ERRORS.has(e.code))) warnings.push({ code: 'CONFIG_PARTIALLY_UNDERSTOOD', path: configPath });
    const files = new Set<string>();
    for (const name of parsed.fileNames) {
      const repoPath = fromVirtual(name);
      if (repoPath !== null && fs.hasFile(repoPath)) files.add(repoPath);
    }
    const references: string[] = [];
    for (const reference of parsed.projectReferences ?? []) {
      let target = fromVirtual(reference.path);
      if (target === null) continue;
      if (fs.hasDirectory(target)) target = target === '' ? 'tsconfig.json' : `${target}/tsconfig.json`;
      if (fs.hasFile(target)) {
        references.push(target);
        if (!visited.has(target)) queue.push(target);
      } else warnings.push({ code: 'PROJECT_REFERENCE_MISSING', path: configPath });
    }
    const options = { ...parsed.options };
    delete options.plugins;
    const outDir = options.outDir ? fromVirtual(options.outDir) : null;
    const rootDir = options.rootDir ? fromVirtual(options.rootDir) : null;
    if (check.external) warnings.push({ code: 'CONFIG_EXTENDS_EXTERNAL', path: configPath });
    contexts.push({
      id: configPath,
      configPath,
      options,
      resolverKind: resolverKindOf(options),
      files,
      incomplete: check.external ? 'CONFIG_EXTENDS_EXTERNAL' : null,
      outDir,
      rootDir,
      references: references.sort(compareUtf8),
      cache: ts.createModuleResolutionCache(VIRTUAL_ROOT, (f) => f, options),
    });
  }
  if (queue.length > 0) warnings.push({ code: 'CONFIG_LIMIT', path: null });
  contexts.sort((a, b) => compareUtf8(a.id, b.id));

  const inferred = { bundler: inferredContext('bundler', host), nodenext: inferredContext('nodenext', host) };
  const byFile = new Map<string, ProjectContext[]>();
  for (const context of contexts) {
    for (const file of context.files) {
      const list = byFile.get(file) ?? [];
      list.push(context);
      byFile.set(file, list);
    }
  }
  const depthOf = (c: ProjectContext) => (c.configPath === null || repoDirname(c.configPath) === '' ? 0 : repoDirname(c.configPath).split('/').length);
  const reportedMultiple = new Set<string>();

  return {
    contexts,
    warnings,
    contextFor(path) {
      const including = byFile.get(path);
      if (including && including.length > 0) {
        const ranked = [...including].sort((a, b) => depthOf(b) - depthOf(a) || a.id.length - b.id.length || compareUtf8(a.id, b.id));
        if (ranked.length > 1 && depthOf(ranked[0]!) === depthOf(ranked[1]!) && !reportedMultiple.has(path)) {
          reportedMultiple.add(path);
          warnings.push({ code: 'MULTIPLE_PROJECT_CONTEXTS', path });
        }
        return { context: ranked[0]!, selection: 'included' };
      }
      // Not included by any config: the nearest ancestor config still supplies aliases
      // and module settings, but results are marked inferred.
      const ancestors = contexts
        .filter((c) => c.configPath !== null && isWithinRepoPath(repoDirname(path), repoDirname(c.configPath)))
        .sort((a, b) => depthOf(b) - depthOf(a) || compareUtf8(a.id, b.id));
      if (ancestors[0]) return { context: ancestors[0], selection: 'ancestor' };
      const ext = repoExtension(path);
      if (ext === '.mts' || ext === '.cts' || ext === '.mjs' || ext === '.cjs' || ext === '.d.mts' || ext === '.d.cts') return { context: inferred.nodenext, selection: 'inferred' };
      // Plan §9.3: a recognized package `type` selects a Node context.
      const manifest = nearestManifest(workspace, path);
      return { context: manifest?.type ? inferred.nodenext : inferred.bundler, selection: 'inferred' };
    },
  };
}
