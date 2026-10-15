import { compareUtf8, repoDirname, type SourceRange } from '@atlas/schema';
import type { PyImportKind, PyRawImport } from './facts.js';
import { normalizeDistribution, owningProject, type PythonProject } from './projects.js';
import { OTHER_RUNTIME_MODULES, isStdlibModule } from './stdlib.js';

/**
 * Static Python import resolution (ADR-057), with the same outcomes and provenance as the
 * TS/JS resolver: an internal file, an external distribution, a standard-library module, or
 * unresolved/unsupported with a reason. Python's own precedence is followed:
 *
 * 1. Relative imports resolve against the importing file's package. They are exact.
 * 2. A top-level standard-library name resolves to the standard library, unless a module of
 *    that name sits in the importing file's own base directory (a script's directory comes
 *    first on `sys.path`). Package source roots come after the standard library, so a
 *    `logging.py` inside a package never shadows it.
 * 3. Otherwise the module is searched, first match wins, in: the file's base directory, its
 *    project's source roots, the other projects' source roots, then the repository root.
 * 4. Otherwise it is an external distribution: declared by the file's project or the root
 *    project (exact), or undeclared (inferred).
 *
 * Each name in `from m import a, b` that is a submodule becomes its own resolution, because
 * importing it executes that file.
 */
export interface PyFileIndex {
  hasFile(path: string): boolean;
  isExcluded(path: string): boolean;
  /** Other spellings of the same path that differ only by case. */
  caseVariants(path: string): string[];
  /** A directory that contains at least one file (excluded files count). */
  hasDirectory(path: string): boolean;
}

export type PyResolutionStatus = 'resolved-internal' | 'resolved-external' | 'builtin' | 'unresolved' | 'unsupported' | 'excluded-target';

export interface PyResolution {
  status: PyResolutionStatus;
  kind: PyImportKind;
  /** The module this resolution is about (`a.b.c`, or `..c` for relative). */
  specifier: string | null;
  range: SourceRange;
  targetPath: string | null;
  /** Normalized distribution name for external targets; top-level module for the standard library. */
  externalName: string | null;
  confidence: 'exact' | 'inferred' | 'heuristic' | null;
  reasonCode: string | null;
  resolverMode: 'python/relative' | 'python/sys-path' | 'python/dynamic' | 'none';
}

/**
 * Import names whose distribution is named differently. Only widely used, unambiguous
 * pairs; a declared distribution always wins over this table.
 */
export const IMPORT_TO_DISTRIBUTION: Readonly<Record<string, string>> = {
  attr: 'attrs',
  bs4: 'beautifulsoup4',
  cv2: 'opencv-python',
  Crypto: 'pycryptodome',
  _distutils_hack: 'setuptools',
  dateutil: 'python-dateutil',
  docx: 'python-docx',
  dotenv: 'python-dotenv',
  fitz: 'pymupdf',
  git: 'gitpython',
  google_auth_oauthlib: 'google-auth-oauthlib',
  jose: 'python-jose',
  jwt: 'pyjwt',
  magic: 'python-magic',
  MySQLdb: 'mysqlclient',
  OpenSSL: 'pyopenssl',
  PIL: 'pillow',
  pkg_resources: 'setuptools',
  pptx: 'python-pptx',
  serial: 'pyserial',
  skimage: 'scikit-image',
  sklearn: 'scikit-learn',
  slugify: 'python-slugify',
  usb: 'pyusb',
  win32api: 'pywin32',
  win32con: 'pywin32',
  yaml: 'pyyaml',
  zmq: 'pyzmq',
};

/** Distribution candidates for a module, most specific first (namespace distributions). */
export function distributionCandidates(module: string): string[] {
  const parts = module.split('.');
  const top = parts[0]!;
  const out: string[] = [];
  // google.cloud.storage -> google-cloud-storage, azure.storage.blob -> azure-storage-blob.
  if (top === 'google' && parts[1] === 'protobuf') out.push('protobuf');
  else if ((top === 'google' || top === 'azure') && parts.length >= 2) {
    for (let n = Math.min(parts.length, 4); n >= 2; n--) out.push(normalizeDistribution(parts.slice(0, n).join('-')));
  }
  if (Object.hasOwn(IMPORT_TO_DISTRIBUTION, top)) out.push(IMPORT_TO_DISTRIBUTION[top]!);
  // A distribution name starts and ends with a letter or digit.
  let start = 0;
  let end = top.length;
  while (start < end && top[start] === '_') start++;
  while (end > start && top[end - 1] === '_') end--;
  const trimmed = top.slice(start, end);
  out.push(normalizeDistribution(trimmed === '' ? top : trimmed));
  return [...new Set(out)];
}

interface Found {
  path: string;
  /** A namespace package: a directory without __init__.py. */
  namespace: boolean;
}

export class PythonResolver {
  constructor(
    private readonly files: PyFileIndex,
    readonly projects: readonly PythonProject[],
  ) {}

  private readonly packageDirs = new Map<string, boolean>();

  private hasInit(dir: string): boolean {
    return this.files.hasFile(`${dir}/__init__.py`) || this.files.hasFile(`${dir}/__init__.pyi`);
  }

  /**
   * Whether a directory is part of a package: it has an __init__, or it is a namespace
   * portion inside one (a directory without __init__ whose parent is a package).
   */
  isPackageDirectory(dir: string): boolean {
    if (dir === '') return false;
    const known = this.packageDirs.get(dir);
    if (known !== undefined) return known;
    const result = this.hasInit(dir) || this.isPackageDirectory(repoDirname(dir));
    this.packageDirs.set(dir, result);
    return result;
  }

  /** The directory a file's top-level package lives in: the nearest ancestor that is not a package. */
  baseDirectory(sourcePath: string): string {
    let dir = repoDirname(sourcePath);
    while (this.isPackageDirectory(dir)) dir = repoDirname(dir);
    return dir;
  }

  /** Ordered, de-duplicated import roots for a file (ADR-057 precedence). */
  rootsFor(sourcePath: string): { roots: string[]; projectRoots: Set<string> } {
    const own = owningProject(this.projects, sourcePath);
    const ownRoots = own?.sourceRoots ?? [];
    const others = this.projects.filter((p) => p !== own).flatMap((p) => p.sourceRoots);
    const roots = [...new Set([this.baseDirectory(sourcePath), ...ownRoots, ...others.sort(compareUtf8), ''])];
    return { roots, projectRoots: new Set(ownRoots) };
  }

  /** `a.b.c` under a directory: module file, package __init__, stub, or namespace directory. */
  private lookup(dir: string, dotted: string): Found | { excluded: string } | { caseMismatch: true } | null {
    const rel = dotted.split('.').join('/');
    const base = dir === '' ? rel : `${dir}/${rel}`;
    // CPython's file finder tries a package before a module; a namespace directory comes
    // last. Runtime files come before stubs.
    const candidates = [`${base}/__init__.py`, `${base}.py`, `${base}/__init__.pyi`, `${base}.pyi`];
    for (const c of candidates) if (this.files.hasFile(c)) return { path: c, namespace: false };
    if (this.files.hasDirectory(base) && !candidates.some((c) => this.files.isExcluded(c))) return { path: base, namespace: true };
    for (const c of candidates) if (this.files.isExcluded(c)) return { excluded: c };
    if (candidates.some((c) => this.files.caseVariants(c).length > 0)) return { caseMismatch: true };
    return null;
  }

  private packageDirFor(project: PythonProject | null, dotted: string): Found | null {
    if (!project) return null;
    const top = dotted.split('.')[0]!;
    const mapped = project.packageDirs.get(top);
    if (mapped === undefined) return null;
    const rest = dotted.split('.').slice(1);
    const found = rest.length === 0 ? (this.files.hasFile(`${mapped}/__init__.py`) ? { path: `${mapped}/__init__.py`, namespace: false } : this.files.hasDirectory(mapped) ? { path: mapped, namespace: true } : null) : this.lookup(mapped, rest.join('.'));
    return found && 'path' in found ? found : null;
  }

  private isDeclared(sourcePath: string, module: string): string | null {
    const own = owningProject(this.projects, sourcePath);
    const root = this.projects.find((p) => p.root === '');
    for (const candidate of distributionCandidates(module)) {
      if (own?.dependencies.has(candidate) || root?.dependencies.has(candidate)) return candidate;
    }
    return null;
  }

  resolveAll(sourcePath: string, imp: PyRawImport): PyResolution[] {
    const base = { kind: imp.kind, specifier: imp.specifier, range: imp.range };
    if (imp.unsupportedReason !== null || imp.specifier === null) {
      return [{ ...base, status: 'unsupported', targetPath: null, externalName: null, confidence: null, reasonCode: imp.unsupportedReason ?? 'NONLITERAL_SPECIFIER', resolverMode: 'none' }];
    }
    const specifier = imp.specifier;
    const dots = /^\.*/.exec(specifier)![0].length;
    const dotted = specifier.slice(dots);
    const mode = imp.usage === 'dynamic' ? 'python/dynamic' : dots > 0 ? 'python/relative' : 'python/sys-path';
    const missing = (reasonCode: string, overrides: Partial<PyResolution> = {}): PyResolution => ({
      ...base,
      status: 'unresolved',
      targetPath: null,
      externalName: null,
      confidence: null,
      // A guarded import expects to be missing at times: it is reported, not flagged as broken.
      reasonCode: imp.guarded && reasonCode === 'LOCAL_TARGET_MISSING' ? 'OPTIONAL_TARGET_MISSING' : reasonCode,
      resolverMode: mode,
      ...overrides,
    });

    // 1. Relative imports: exact, against the importing file's package. Climbing out of the
    //    top-level package is an import error in Python, reported as such.
    if (dots > 0) {
      let dir = repoDirname(sourcePath);
      for (let i = 1; i < dots; i++) {
        if (!this.isPackageDirectory(dir)) return [missing('RELATIVE_BEYOND_TOP_LEVEL')];
        dir = repoDirname(dir);
      }
      // Two or more dots must land inside a package; one dot names the file's own directory.
      if (dots > 1 && !this.isPackageDirectory(dir)) return [missing('RELATIVE_BEYOND_TOP_LEVEL')];
      const found = dotted === '' ? this.packageInit(dir) : this.lookup(dir, dotted);
      return this.withNames(imp, found, mode, 'exact', null, (name) => `${specifier}${dotted === '' ? '' : '.'}${name}`, missing);
    }

    const top = dotted.split('.')[0]!;
    const { roots, projectRoots } = this.rootsFor(sourcePath);
    const baseDir = roots[0]!;

    // 2. The standard library, unless the script's own directory shadows the name.
    if (isStdlibModule(top)) {
      const shadow = this.lookup(baseDir, dotted);
      if (shadow && 'path' in shadow && !shadow.namespace) {
        return this.withNames(imp, shadow, mode, 'inferred', 'STDLIB_SHADOWED', (n) => `${dotted}.${n}`, missing);
      }
      return [{ ...base, status: 'builtin', targetPath: null, externalName: top, confidence: 'exact', reasonCode: null, resolverMode: mode }];
    }

    // 3. Import roots, first match wins; a second, different match makes the result inferred.
    const own = owningProject(this.projects, sourcePath);
    const mapped = this.packageDirFor(own, dotted);
    if (mapped) return this.withNames(imp, mapped, mode, 'exact', null, (n) => `${dotted}.${n}`, missing);
    let first: { found: Found; root: string } | null = null;
    let ambiguous = false;
    let excluded: string | null = null;
    let caseMismatch = false;
    for (const root of roots) {
      const found = this.lookup(root, dotted);
      if (!found) continue;
      if ('excluded' in found) {
        excluded ??= found.excluded;
        continue;
      }
      if ('caseMismatch' in found) {
        caseMismatch = true;
        continue;
      }
      if (!first) first = { found, root };
      else if (!found.namespace && !first.found.namespace && found.path !== first.found.path) ambiguous = true;
    }
    if (first) {
      const inProject = first.root === baseDir || projectRoots.has(first.root);
      const confidence = ambiguous || !inProject ? 'inferred' : 'exact';
      const reason = ambiguous ? 'AMBIGUOUS_MODULE_ROOT' : !inProject ? (first.root === '' ? 'REPOSITORY_ROOT_MODULE' : 'WORKSPACE_PROJECT_MODULE') : null;
      return this.withNames(imp, first.found, mode, confidence, reason, (n) => `${dotted}.${n}`, missing);
    }
    if (excluded !== null) return [missing('TARGET_EXCLUDED', { status: 'excluded-target' })];
    if (caseMismatch) return [missing('CASE_MISMATCH')];
    // The repository has the top-level package but not this submodule: a missing local
    // target, never an external package of the same name.
    if (dotted.includes('.') && roots.some((root) => { const f = this.lookup(root, top); return f !== null && 'path' in f; })) return [missing('LOCAL_TARGET_MISSING')];
    const other = OTHER_RUNTIME_MODULES.get(top);
    if (other) return [{ ...base, status: 'builtin', targetPath: null, externalName: top, confidence: 'inferred', reasonCode: other, resolverMode: mode }];

    // 4. An external distribution, declared or inferred.
    const declared = this.isDeclared(sourcePath, dotted);
    return [
      {
        ...base,
        status: 'resolved-external',
        targetPath: null,
        externalName: declared ?? distributionCandidates(dotted)[0]!,
        confidence: declared ? 'exact' : 'inferred',
        reasonCode: declared ? null : imp.guarded ? 'OPTIONAL_EXTERNAL_IMPORT' : 'UNDECLARED_EXTERNAL_IMPORT',
        resolverMode: mode,
      },
    ];
  }

  private packageInit(dir: string): Found | null {
    for (const init of [`${dir === '' ? '' : `${dir}/`}__init__.py`, `${dir === '' ? '' : `${dir}/`}__init__.pyi`]) if (this.files.hasFile(init)) return { path: init, namespace: false };
    return this.files.hasDirectory(dir) ? { path: dir, namespace: true } : null;
  }

  /**
   * The statement's own resolution, plus one per imported name that is a submodule. A
   * namespace package has no file of its own, so only its submodules appear; a name that
   * is neither a submodule nor importable from a file is unresolved.
   */
  private withNames(
    imp: PyRawImport,
    found: Found | { excluded: string } | { caseMismatch: true } | null,
    mode: PyResolution['resolverMode'],
    confidence: 'exact' | 'inferred',
    reasonCode: string | null,
    nameSpecifier: (name: string) => string,
    missing: (reasonCode: string, overrides?: Partial<PyResolution>) => PyResolution,
  ): PyResolution[] {
    if (!found) return [missing('LOCAL_TARGET_MISSING')];
    if ('excluded' in found) return [missing('TARGET_EXCLUDED', { status: 'excluded-target' })];
    if ('caseMismatch' in found) return [missing('CASE_MISMATCH')];
    const kindFor = (path: string): PyImportKind => (path.endsWith('.pyi') ? (imp.kind.startsWith('reexports') ? 'reexports-type' : imp.kind === 'imports-dynamic-literal' ? imp.kind : 'imports-type') : imp.kind);
    const out: PyResolution[] = [];
    if (!found.namespace) out.push({ kind: kindFor(found.path), specifier: imp.specifier, range: imp.range, status: 'resolved-internal', targetPath: found.path, externalName: null, confidence, reasonCode, resolverMode: mode });
    const dir = found.namespace ? found.path : found.path.endsWith('/__init__.py') || found.path.endsWith('/__init__.pyi') ? repoDirname(found.path) : null;
    for (const name of imp.names ?? []) {
      const sub = dir === null ? null : this.lookup(dir, name.name);
      const at = { specifier: nameSpecifier(name.name), range: name.range };
      if (sub && 'path' in sub && !sub.namespace) out.push({ kind: kindFor(sub.path), ...at, status: 'resolved-internal', targetPath: sub.path, externalName: null, confidence, reasonCode, resolverMode: mode });
      else if (sub && 'excluded' in sub) out.push({ ...missing('TARGET_EXCLUDED', { status: 'excluded-target' }), ...at });
      else if (found.namespace && !(sub && 'path' in sub)) out.push({ ...missing(sub && 'caseMismatch' in sub ? 'CASE_MISMATCH' : 'LOCAL_TARGET_MISSING'), ...at });
    }
    if (out.length === 0) {
      // `import ns` of a namespace package, or a wildcard from one: nothing file-backed to point at.
      out.push({ kind: imp.kind, specifier: imp.specifier, range: imp.range, status: 'unsupported', targetPath: null, externalName: null, confidence: null, reasonCode: 'NAMESPACE_PACKAGE', resolverMode: mode });
    }
    return out;
  }
}

/** A file index over path lists: included files, excluded files, and their directories. */
export class PathIndex implements PyFileIndex {
  private readonly files: Set<string>;
  private readonly excluded: Set<string>;
  private readonly directories = new Set<string>();
  private readonly lower = new Map<string, string[]>();

  constructor(included: Iterable<string>, excluded: Iterable<string> = []) {
    this.files = new Set(included);
    this.excluded = new Set(excluded);
    for (const path of [...this.files, ...this.excluded]) {
      const key = path.toLowerCase();
      this.lower.set(key, [...(this.lower.get(key) ?? []), path]);
      for (let dir = repoDirname(path); dir !== ''; dir = repoDirname(dir)) {
        if (this.directories.has(dir)) break;
        this.directories.add(dir);
      }
    }
  }
  hasFile(path: string): boolean {
    return this.files.has(path);
  }
  isExcluded(path: string): boolean {
    return this.excluded.has(path);
  }
  caseVariants(path: string): string[] {
    return (this.lower.get(path.toLowerCase()) ?? []).filter((p) => p !== path);
  }
  hasDirectory(path: string): boolean {
    return path === '' || this.directories.has(path);
  }
}
