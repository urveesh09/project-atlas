import ts from 'typescript';
import { isWithinRepoPath, repoDirname, type Confidence, type EdgeKind, type ObservationStatus } from '@atlas/schema';
import { NODE_BUILTINS } from './builtins.js';
import { discoverProjects, type ProjectContext, type ProjectSet } from './config.js';
import { isSupportedSourcePath, type RawImport } from './extract.js';
import { createVirtualHost, type VirtualHost } from './host.js';
import { originalPathOf } from './internal.js';
import { fromVirtual, toVirtual, type SnapshotFS } from './vfs.js';
import { discoverWorkspace, nearestManifest, packageNameOf, type PackageManifest, type WorkspaceMap } from './workspace.js';

/**
 * Static import resolution with explicit provenance (plan §9.3). Outcome precedence:
 *   1. compiler/config-aware internal target (including aliases that look bare)
 *   2. Node built-in
 *   3. in-repository workspace package (virtual map, then source fallback)
 *   4. declared npm package, 5. undeclared npm package (inferred)
 *   6. unresolved with a reason, 7. unsupported constructs (never fetched)
 */
export interface Resolution {
  status: ObservationStatus;
  kind: EdgeKind;
  targetPath: string | null;
  /** npm package name for external targets; module name (no `node:`) for builtins. */
  externalName: string | null;
  confidence: Confidence | null;
  reasonCode: string | null;
  /** `<resolver kind>/<esm|cjs>` or `none` when no resolver ran. */
  resolverMode: string;
  contextId: string;
}

export function classifyBuiltin(specifier: string): string | null {
  if (specifier.startsWith('node:')) {
    const name = specifier.slice(5);
    return NODE_BUILTINS.has(name) || NODE_BUILTINS.has(specifier) ? name : null;
  }
  return NODE_BUILTINS.has(specifier) ? specifier : null;
}

const URL_LIKE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const CONVENTIONAL_ENTRIES = ['src/index.ts', 'src/index.tsx', 'src/index.mts', 'src/index.js', 'src/index.jsx', 'src/index.mjs', 'index.ts', 'index.tsx', 'index.js', 'index.mjs'];
const EXPORT_CONDITIONS = new Set(['types', 'import', 'module', 'require', 'node', 'default']);

export class SnapshotResolver {
  readonly workspace: WorkspaceMap;
  readonly projects: ProjectSet;
  readonly host: VirtualHost;

  constructor(readonly fs: SnapshotFS) {
    this.workspace = discoverWorkspace(fs);
    this.host = createVirtualHost(fs, this.workspace);
    this.projects = discoverProjects(fs, this.host, this.workspace);
  }

  resolve(sourcePath: string, imp: RawImport): Resolution {
    const { context, selection } = this.projects.contextFor(sourcePath);
    const base = { contextId: context.id };
    const kind: EdgeKind = imp.kind;
    if (imp.unsupportedReason !== null || imp.specifier === null) {
      return { ...base, status: 'unsupported', kind, targetPath: null, externalName: null, confidence: null, reasonCode: imp.unsupportedReason ?? 'NONLITERAL_SPECIFIER', resolverMode: 'none' };
    }
    const specifier = imp.specifier;
    if (URL_LIKE.test(specifier) && !specifier.startsWith('node:')) {
      return { ...base, status: 'unsupported', kind, targetPath: null, externalName: null, confidence: null, reasonCode: 'URL_IMPORT_UNSUPPORTED', resolverMode: 'none' };
    }

    const virtualSource = toVirtual(sourcePath);
    const mode = this.resolutionMode(virtualSource, imp, context);
    const resolverMode = `${context.resolverKind}/${mode === ts.ModuleKind.CommonJS ? 'cjs' : 'esm'}`;
    const outcome = (partial: Omit<Resolution, 'contextId' | 'resolverMode'>): Resolution => ({ ...partial, contextId: context.id, resolverMode });

    // 1. Compiler/config-aware resolution over the virtual snapshot.
    const attempt = this.compilerResolve(specifier, virtualSource, context, mode);
    if (attempt) {
      const exact = selection === 'included' && context.incomplete === null && !attempt.viaWorkspace && !attempt.relaxed;
      return outcome({
        status: 'resolved-internal',
        kind: this.finalKind(kind, attempt.path),
        targetPath: attempt.path,
        externalName: null,
        confidence: exact ? 'exact' : 'inferred',
        reasonCode: attempt.viaWorkspace ? 'WORKSPACE_PACKAGE_MAP' : null,
      });
    }

    // 2. Node built-ins (after aliases, so a configured alias named like a builtin wins).
    const builtin = classifyBuiltin(specifier);
    if (builtin !== null) return outcome({ status: 'builtin', kind, targetPath: null, externalName: builtin, confidence: 'exact', reasonCode: null });

    const isRelative = specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..' || specifier.startsWith('/');
    if (isRelative) return outcome(this.unresolvedLocal(sourcePath, specifier, kind, context));
    if (specifier.startsWith('#')) {
      return outcome({ status: 'unresolved', kind, targetPath: null, externalName: null, confidence: null, reasonCode: 'PACKAGE_EXPORT_UNSUPPORTED' });
    }

    const packageName = packageNameOf(specifier);
    // 3. Workspace package whose declared entry is absent (e.g. uncommitted build output).
    const workspacePackage = packageName ? this.workspace.byName.get(packageName) : undefined;
    if (packageName && workspacePackage) {
      return outcome(this.workspaceFallback(workspacePackage, specifier.slice(packageName.length), kind));
    }
    const aliasMatched = this.matchesPathsAlias(specifier, context);
    if (packageName && !aliasMatched) {
      // 4/5. npm package outside the repository: declared ranges or inferred.
      const declared = this.isDeclared(sourcePath, packageName);
      return outcome({
        status: 'resolved-external',
        kind,
        targetPath: null,
        externalName: packageName,
        confidence: declared ? 'exact' : 'inferred',
        reasonCode: declared ? null : 'UNDECLARED_EXTERNAL_IMPORT',
      });
    }
    // 6. Alias-like specifiers that the safe configuration context cannot explain.
    let reasonCode = 'ALIAS_UNSUPPORTED';
    if (aliasMatched) reasonCode = 'LOCAL_TARGET_MISSING';
    else if (context.incomplete !== null || context.configPath === null) reasonCode = 'CONFIG_CONTEXT_MISSING';
    return outcome({ status: 'unresolved', kind, targetPath: null, externalName: null, confidence: null, reasonCode });
  }

  private resolutionMode(virtualSource: string, imp: RawImport, context: ProjectContext): ts.ResolutionMode {
    if (imp.usage === 'require') return ts.ModuleKind.CommonJS;
    if (imp.usage === 'dynamic') return ts.ModuleKind.ESNext;
    if (context.resolverKind === 'node16' || context.resolverKind === 'nodenext') {
      const format = ts.getImpliedNodeFormatForFile(virtualSource, context.cache.getPackageJsonInfoCache(), this.host, context.options);
      return format === ts.ModuleKind.CommonJS ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext;
    }
    return ts.ModuleKind.ESNext;
  }

  private compilerResolve(
    specifier: string,
    virtualSource: string,
    context: ProjectContext,
    mode: ts.ResolutionMode,
  ): { path: string; viaWorkspace: boolean; relaxed: boolean } | null {
    const run = (options: ts.CompilerOptions, cache: ts.ModuleResolutionCache | undefined) =>
      ts.resolveModuleName(specifier, virtualSource, options, this.host, cache, undefined, mode).resolvedModule;
    let resolved = run(context.options, context.cache);
    let relaxed = false;
    if (!resolved && (!context.options.allowJs || !context.options.resolveJsonModule)) {
      // Dependency discovery also needs JS/JSON targets that a type-check-only config
      // would not consider; such matches are recorded as inferred.
      resolved = run({ ...context.options, allowJs: true, resolveJsonModule: true }, undefined);
      relaxed = resolved !== undefined;
    }
    if (!resolved) return null;
    const viaWorkspace = this.host.isWorkspaceMapped(originalPathOf(resolved) ?? resolved.resolvedFileName) || this.host.isWorkspaceMapped(resolved.resolvedFileName);
    const path = this.host.repoPathOf(this.host.realpath(resolved.resolvedFileName));
    if (path === null || !this.fs.hasFile(path)) return null;
    return { path, viaWorkspace, relaxed };
  }

  private finalKind(kind: EdgeKind, targetPath: string): EdgeKind {
    if (isSupportedSourcePath(targetPath)) return kind;
    // Static imports of JSON, styles, images and other non-code files are resources.
    return kind === 'imports-type' || kind === 'reexports-type' ? kind : 'imports-resource';
  }

  private unresolvedLocal(sourcePath: string, specifier: string, kind: EdgeKind, context: ProjectContext): Omit<Resolution, 'contextId' | 'resolverMode'> {
    const fail = (reasonCode: string, status: ObservationStatus = 'unresolved') => ({ status, kind, targetPath: null, externalName: null, confidence: null, reasonCode });
    if (specifier.startsWith('/')) return fail('LOCAL_TARGET_MISSING');
    const base = fromVirtual(`${toVirtual(repoDirname(sourcePath))}/${specifier}`);
    if (base === null) return fail('LOCAL_TARGET_MISSING');
    const stripped = base.replace(/\.(?:[cm]?js|jsx)$/, '');
    const candidates = [base, ...SOURCE_EXTENSIONS.map((e) => `${stripped}${e}`), ...SOURCE_EXTENSIONS.map((e) => `${base}/index${e}`)];
    // A direct import of an existing non-code file (styles, images, data) is a resource.
    if (this.fs.hasFile(base) && !isSupportedSourcePath(base)) {
      return { status: 'resolved-internal', kind: kind === 'imports-type' || kind === 'reexports-type' ? kind : 'imports-resource', targetPath: base, externalName: null, confidence: 'inferred', reasonCode: null };
    }
    if (candidates.some((c) => this.fs.isExcluded(c))) return fail('TARGET_EXCLUDED', 'excluded-target');
    if (candidates.some((c) => this.fs.caseVariants(c).length > 0)) return fail('CASE_MISMATCH');
    if (context.outDir !== null && isWithinRepoPath(base, context.outDir)) return fail('GENERATED_TARGET_MISSING');
    return fail('LOCAL_TARGET_MISSING');
  }

  private matchesPathsAlias(specifier: string, context: ProjectContext): boolean {
    const paths = context.options.paths;
    if (!paths) return false;
    return Object.keys(paths).some((pattern) => {
      const star = pattern.indexOf('*');
      if (star === -1) return pattern === specifier;
      return specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1)) && specifier.length >= pattern.length - 1;
    });
  }

  private isDeclared(sourcePath: string, packageName: string): boolean {
    const nearest = nearestManifest(this.workspace, sourcePath);
    if (nearest?.dependencies.has(packageName)) return true;
    const root = this.workspace.manifests.find((m) => m.root === '');
    return root?.dependencies.has(packageName) ?? false;
  }

  /** Declared ranges for an external package across every manifest (for graph nodes). */
  declaredRanges(packageName: string): { manifest: PackageManifest; field: string; range: string }[] {
    const out: { manifest: PackageManifest; field: string; range: string }[] = [];
    for (const manifest of this.workspace.manifests) {
      for (const entry of manifest.dependencies.get(packageName) ?? []) out.push({ manifest, field: entry.field, range: entry.range });
    }
    return out;
  }

  private workspaceFallback(pkg: PackageManifest, rest: string, kind: EdgeKind): Omit<Resolution, 'contextId' | 'resolverMode'> {
    const subpath = rest === '' ? '.' : `.${rest}`;
    const within = (relative: string): string | null => {
      const joined = fromVirtual(`${toVirtual(pkg.root)}/${relative}`);
      return joined !== null && isWithinRepoPath(joined, pkg.root) ? joined : null;
    };
    const declared: string[] = [];
    const exportTarget = pickExportTarget(pkg.entryFields.exports, subpath);
    if (exportTarget) declared.push(exportTarget);
    if (subpath === '.' && pkg.entryFields.exports === null) {
      for (const field of [pkg.entryFields.types, pkg.entryFields.module, pkg.entryFields.main]) if (field) declared.push(field);
    }
    if (subpath !== '.' && pkg.entryFields.exports === null) declared.push(subpath);

    const pkgContext = this.projects.contexts.find((c) => c.configPath !== null && repoDirname(c.configPath) === pkg.root);
    for (const target of declared) {
      const path = within(target);
      if (path === null) continue;
      if (this.fs.hasFile(path)) {
        return { status: 'resolved-internal', kind: this.finalKind(kind, path), targetPath: path, externalName: null, confidence: 'inferred', reasonCode: 'WORKSPACE_PACKAGE_MAP' };
      }
      const source = this.mapOutputToSource(path, pkg, pkgContext);
      if (source) {
        return { status: 'resolved-internal', kind: this.finalKind(kind, source), targetPath: source, externalName: null, confidence: 'inferred', reasonCode: 'WORKSPACE_SOURCE_FALLBACK' };
      }
    }
    if (subpath === '.') {
      for (const entry of CONVENTIONAL_ENTRIES) {
        const path = within(entry);
        if (path && this.fs.hasFile(path)) {
          return { status: 'resolved-internal', kind: this.finalKind(kind, path), targetPath: path, externalName: null, confidence: 'heuristic', reasonCode: 'WORKSPACE_CONVENTIONAL_ENTRY' };
        }
      }
    }
    return { status: 'unresolved', kind, targetPath: null, externalName: null, confidence: null, reasonCode: declared.length > 0 ? 'GENERATED_TARGET_MISSING' : 'PACKAGE_EXPORT_UNSUPPORTED' };
  }

  /** Map a missing build-output path (dist/x.js, dist/x.d.ts) to committed source. */
  private mapOutputToSource(path: string, pkg: PackageManifest, context: ProjectContext | undefined): string | null {
    const outDir = context?.outDir ?? null;
    const sourceRoots = context?.rootDir ? [context.rootDir] : [pkg.root === '' ? 'src' : `${pkg.root}/src`, pkg.root];
    let relative: string | null = null;
    if (outDir !== null && isWithinRepoPath(path, outDir)) relative = path.slice(outDir.length).replace(/^\//, '');
    else {
      const conventional = /^(?:dist|build|lib|out)\/(.+)$/.exec(pkg.root === '' ? path : path.slice(pkg.root.length + 1));
      if (conventional) relative = conventional[1]!;
    }
    if (relative === null) return null;
    const stem = relative.replace(/\.d\.[cm]?ts$/, '').replace(/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/, '');
    for (const root of sourceRoots) {
      for (const ext of SOURCE_EXTENSIONS) {
        if (ext === '.d.ts') continue;
        for (const candidate of [`${root}/${stem}${ext}`, `${root}/${stem}/index${ext}`]) {
          const normalized = fromVirtual(toVirtual(candidate));
          if (normalized && this.fs.hasFile(normalized)) return normalized;
        }
      }
    }
    return null;
  }
}

/** Pick an `exports` target for a subpath using fixed, recorded conditions. */
export function pickExportTarget(exportsField: unknown, subpath: string): string | null {
  const fromConditions = (value: unknown, depth = 0): string | null => {
    if (depth > 8) return null;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = fromConditions(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const [condition, nested] of Object.entries(value as Record<string, unknown>)) {
        if (EXPORT_CONDITIONS.has(condition)) {
          const found = fromConditions(nested, depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  };
  if (exportsField === null || exportsField === undefined) return null;
  if (typeof exportsField === 'string' || Array.isArray(exportsField)) return subpath === '.' ? fromConditions(exportsField) : null;
  if (typeof exportsField !== 'object') return null;
  const entries = Object.entries(exportsField as Record<string, unknown>);
  const isSubpathMap = entries.some(([key]) => key.startsWith('.'));
  if (!isSubpathMap) return subpath === '.' ? fromConditions(exportsField) : null;
  const exact = (exportsField as Record<string, unknown>)[subpath];
  if (exact !== undefined) return fromConditions(exact);
  for (const [key, value] of entries) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1) {
      const target = fromConditions(value);
      if (target) return target.replaceAll('*', subpath.slice(prefix.length, subpath.length - suffix.length));
    }
  }
  return null;
}
