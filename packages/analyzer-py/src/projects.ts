import { compareUtf8, isWithinRepoPath, repoBasename, repoDirname } from '@atlas/schema';
import { parse as parseToml } from 'smol-toml';
import type { Node } from 'web-tree-sitter';
import { pythonParser } from './parser.js';

/**
 * Python projects in a snapshot (ADR-057): where each project's import roots are and what it
 * declares it depends on, read statically from committed manifests. Nothing is executed:
 * `setup.py` contributes only literal keyword arguments of its `setup()` call, read from
 * its syntax tree. Manifests are untrusted input: every value is checked before use.
 */
export type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies';

export interface PyDeclaredDependency {
  field: DependencyField;
  /** Version specifier as written (`>=2,<3`), `*` when none, `url` for a direct reference. */
  range: string;
  manifestPath: string;
}

export interface PythonProject {
  /** Project directory ('' = repository root). */
  root: string;
  name: string | null;
  /** PEP 503 normalized name. */
  normalizedName: string | null;
  manifestPath: string;
  /** Import roots, most specific first ('' = repository root). */
  sourceRoots: string[];
  /** Import name -> directory, from explicit package-dir mappings. */
  packageDirs: Map<string, string>;
  /** Normalized distribution name -> declarations. */
  dependencies: Map<string, PyDeclaredDependency[]>;
  /** The root project, or a member of a declared uv workspace. */
  workspace: boolean;
}

export interface ProjectFile {
  path: string;
  text: string | null;
}

export interface ProjectDiscovery {
  projects: PythonProject[];
  warnings: { code: string; path: string | null }[];
}

export const PYTHON_MANIFEST_NAMES = new Set(['pyproject.toml', 'setup.cfg', 'setup.py', 'Pipfile']);
const REQUIREMENTS = /^(?:requirements|requires|constraints)(?:[-_.][\w.-]*)?\.(?:txt|in)$/i;
/** Fixture and test-data trees hold sample projects, not parts of this repository's build. */
const FIXTURE_SEGMENT = /(?:^|\/)(?:tests?|testing|testdata|test_data|fixtures?|__fixtures__)(?:\/|$)/;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export function isPythonManifest(path: string): boolean {
  const base = repoBasename(path);
  return PYTHON_MANIFEST_NAMES.has(base) || REQUIREMENTS.test(base);
}

/** PEP 503 name normalization. */
export function normalizeDistribution(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Parses one PEP 508 requirement line: name and version specifier only. */
export function parseRequirement(line: string): { name: string; range: string } | null {
  const text = line.replace(/\s+#.*$/, '').trim();
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]{0,200}[A-Za-z0-9])?)\s*(?:\[[^\]]{0,500}\])?\s*(.*)$/.exec(text);
  if (!match) return null;
  let rest = match[2]!;
  const marker = rest.indexOf(';');
  if (marker >= 0) rest = rest.slice(0, marker);
  rest = rest.trim();
  let range = '*';
  if (rest.startsWith('@')) range = 'url';
  else if (rest.length > 0) {
    if (!/^[<>=!~(]/.test(rest)) return null;
    range = rest.replace(/^\(|\)$/g, '').replace(/\s+/g, '').slice(0, 200) || '*';
  }
  return { name: match[1]!, range };
}

const record = (value: unknown): Record<string, unknown> | null => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const own = (obj: Record<string, unknown> | null, key: string): unknown => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
const joinRoot = (root: string, rel: string): string | null => {
  const parts = [...(root ? root.split('/') : [])];
  for (const segment of rel.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
};

interface Draft {
  root: string;
  name: string | null;
  manifestPath: string | null;
  explicitRoots: string[];
  packageDirs: Map<string, string>;
  dependencies: Map<string, PyDeclaredDependency[]>;
  workspaceMembers: string[] | null;
}

function draftFor(drafts: Map<string, Draft>, root: string): Draft {
  let draft = drafts.get(root);
  if (!draft) {
    draft = { root, name: null, manifestPath: null, explicitRoots: [], packageDirs: new Map(), dependencies: new Map(), workspaceMembers: null };
    drafts.set(root, draft);
  }
  return draft;
}

const DISTRIBUTION_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,200}[A-Za-z0-9])?$/;

function declareNamed(draft: Draft, name: string, range: string, field: DependencyField, manifestPath: string): void {
  if (!DISTRIBUTION_NAME.test(name)) return;
  const key = normalizeDistribution(name);
  const list = draft.dependencies.get(key) ?? [];
  list.push({ field, range: range.replace(/\s+/g, '').slice(0, 200) || '*', manifestPath });
  draft.dependencies.set(key, list);
}

/** A PEP 508 requirement string. */
function declare(draft: Draft, requirement: string, field: DependencyField, manifestPath: string): void {
  const parsed = parseRequirement(requirement);
  if (parsed) declareNamed(draft, parsed.name, parsed.range, field, manifestPath);
}

/** Poetry and Pipfile tables: name -> constraint string or a table with `version`. */
function declareTable(draft: Draft, table: unknown, field: DependencyField, manifestPath: string): void {
  const deps = record(table);
  if (!deps) return;
  for (const key of Object.keys(deps)) {
    if (key.toLowerCase() === 'python') continue;
    const value = deps[key];
    const spec = record(value);
    const range = typeof value === 'string' ? value : typeof own(spec, 'version') === 'string' ? (own(spec, 'version') as string) : ['path', 'git', 'url', 'file'].some((k) => own(spec, k) !== undefined) ? 'url' : '*';
    declareNamed(draft, key, range, field, manifestPath);
  }
}

function readPyproject(draft: Draft, path: string, text: string, warn: (code: string) => void): void {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text) as Record<string, unknown>;
  } catch {
    warn('PYPROJECT_INVALID');
    return;
  }
  const project = record(own(doc, 'project'));
  const tool = record(own(doc, 'tool'));
  const poetry = record(own(tool, 'poetry'));
  const name = own(project, 'name') ?? own(poetry, 'name');
  if (typeof name === 'string' && name.length <= 200) draft.name ??= name;
  draft.manifestPath ??= path;
  for (const req of strings(own(project, 'dependencies'))) declare(draft, req, 'dependencies', path);
  const optional = record(own(project, 'optional-dependencies'));
  if (optional) for (const key of Object.keys(optional)) for (const req of strings(optional[key])) declare(draft, req, 'optionalDependencies', path);
  const groups = record(own(doc, 'dependency-groups'));
  if (groups) for (const key of Object.keys(groups)) for (const req of strings(groups[key])) declare(draft, req, 'devDependencies', path);
  const uv = record(own(tool, 'uv'));
  for (const req of strings(own(uv, 'dev-dependencies'))) declare(draft, req, 'devDependencies', path);
  const workspace = record(own(uv, 'workspace'));
  if (workspace) draft.workspaceMembers = strings(own(workspace, 'members')).slice(0, 500);
  const pdm = record(own(tool, 'pdm'));
  const pdmDev = record(own(pdm, 'dev-dependencies'));
  if (pdmDev) for (const key of Object.keys(pdmDev)) for (const req of strings(pdmDev[key])) declare(draft, req, 'devDependencies', path);
  // Poetry: name -> constraint tables, plus dependency groups.
  declareTable(draft, own(poetry, 'dependencies'), 'dependencies', path);
  declareTable(draft, own(poetry, 'dev-dependencies'), 'devDependencies', path);
  const poetryGroups = record(own(poetry, 'group'));
  if (poetryGroups) for (const key of Object.keys(poetryGroups)) declareTable(draft, own(record(poetryGroups[key]), 'dependencies'), 'devDependencies', path);

  // Import roots, from every build backend that names them.
  const setuptools = record(own(tool, 'setuptools'));
  const packageDir = record(own(setuptools, 'package-dir'));
  if (packageDir)
    for (const key of Object.keys(packageDir)) {
      const dir = packageDir[key];
      if (typeof dir !== 'string') continue;
      const joined = joinRoot(draft.root, dir);
      if (joined === null) continue;
      if (key === '') draft.explicitRoots.push(joined);
      else draft.packageDirs.set(key, joined);
    }
  const find = record(own(record(own(setuptools, 'packages')), 'find'));
  for (const where of strings(own(find, 'where'))) {
    const joined = joinRoot(draft.root, where);
    if (joined !== null) draft.explicitRoots.push(joined);
  }
  for (const pkg of Array.isArray(own(poetry, 'packages')) ? (own(poetry, 'packages') as unknown[]) : []) {
    const from = own(record(pkg), 'from');
    if (typeof from === 'string') {
      const joined = joinRoot(draft.root, from);
      if (joined !== null) draft.explicitRoots.push(joined);
    }
  }
  const wheel = record(own(record(own(record(own(record(own(tool, 'hatch')), 'build')), 'targets')), 'wheel'));
  for (const pkg of strings(own(wheel, 'packages'))) {
    const joined = joinRoot(draft.root, pkg);
    if (joined !== null) draft.explicitRoots.push(repoDirname(joined));
  }
  const pdmBuild = record(own(pdm, 'build'));
  const pdmDir = own(pdmBuild, 'package-dir');
  if (typeof pdmDir === 'string') {
    const joined = joinRoot(draft.root, pdmDir);
    if (joined !== null) draft.explicitRoots.push(joined);
  }
  const maturin = record(own(tool, 'maturin'));
  const pythonSource = own(maturin, 'python-source');
  if (typeof pythonSource === 'string') {
    const joined = joinRoot(draft.root, pythonSource);
    if (joined !== null) draft.explicitRoots.push(joined);
  }
}

/** A minimal INI reader for setup.cfg: sections, keys and indented continuation lines. */
function readIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | null = null;
  let key: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(raw) || raw.trim() === '') continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(raw);
    if (header) {
      section = new Map();
      sections.set(header[1]!.trim(), section);
      key = null;
      continue;
    }
    if (!section) continue;
    if (/^\s/.test(raw) && key !== null) {
      section.set(key, `${section.get(key)}\n${raw.trim()}`);
      continue;
    }
    const pair = /^([^=:]+)[=:](.*)$/.exec(raw);
    if (pair) {
      key = pair[1]!.trim().toLowerCase().replace(/-/g, '_');
      section.set(key, pair[2]!.trim());
    }
  }
  return sections;
}

function readSetupCfg(draft: Draft, path: string, text: string): void {
  const ini = readIni(text);
  const name = ini.get('metadata')?.get('name');
  if (name && name.length <= 200) draft.name ??= name;
  draft.manifestPath ??= path;
  const options = ini.get('options');
  for (const line of (options?.get('install_requires') ?? '').split('\n')) if (line.trim()) declare(draft, line, 'dependencies', path);
  for (const [, value] of ini.get('options.extras_require') ?? new Map<string, string>()) for (const line of value.split('\n')) if (line.trim()) declare(draft, line, 'optionalDependencies', path);
  for (const line of (options?.get('package_dir') ?? '').split('\n')) {
    const mapping = /^([\w.]*)\s*=\s*(.+)$/.exec(line.trim());
    if (!mapping) continue;
    const joined = joinRoot(draft.root, mapping[2]!.trim());
    if (joined === null) continue;
    if (mapping[1] === '') draft.explicitRoots.push(joined);
    else draft.packageDirs.set(mapping[1]!, joined);
  }
  const where = ini.get('options.packages.find')?.get('where');
  if (where) {
    const joined = joinRoot(draft.root, where.trim());
    if (joined !== null) draft.explicitRoots.push(joined);
  }
}

/** Literal values only: a string, or a list/tuple/dict of them. Anything else is null. */
function literal(node: Node | null): unknown {
  if (!node) return null;
  if (node.type === 'string') {
    if (node.namedChildren.some((c) => c?.type === 'interpolation')) return null;
    const start = node.namedChildren.find((c) => c?.type === 'string_start')?.text ?? '';
    if (/[fbt]/i.test(start.replace(/["']+$/, ''))) return null;
    return node.namedChildren
      .filter((c) => c?.type === 'string_content')
      .map((c) => c!.text)
      .join('');
  }
  if (node.type === 'list' || node.type === 'tuple') {
    const out: unknown[] = [];
    for (const child of node.namedChildren) {
      if (!child || child.type === 'comment') continue;
      const value = literal(child);
      if (value === null) return null;
      out.push(value);
    }
    return out;
  }
  if (node.type === 'dictionary') {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const pair of node.namedChildren) {
      if (!pair || pair.type === 'comment') continue;
      if (pair.type !== 'pair') return null;
      const k = literal(pair.childForFieldName('key'));
      const v = literal(pair.childForFieldName('value'));
      if (typeof k !== 'string' || v === null) return null;
      out[k] = v;
    }
    return out;
  }
  return null;
}

function readSetupPy(draft: Draft, path: string, text: string, warn: (code: string) => void): void {
  const tree = pythonParser().parse(text);
  if (!tree) return;
  try {
    if (tree.rootNode.hasError) {
      warn('SETUP_PY_UNPARSEABLE');
      return;
    }
    draft.manifestPath ??= path;
    const stack: Node[] = [tree.rootNode];
    let found = false;
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === 'call') {
        const fn = node.childForFieldName('function');
        const callee = fn?.type === 'attribute' ? fn.childForFieldName('attribute')?.text : fn?.text;
        if (callee === 'setup') {
          found = true;
          let nonLiteral = false;
          for (const argument of node.childForFieldName('arguments')?.namedChildren ?? []) {
            if (argument?.type !== 'keyword_argument') continue;
            const key = argument.childForFieldName('name')?.text;
            const value = literal(argument.childForFieldName('value'));
            if (key === 'name') {
              if (typeof value === 'string' && value.length <= 200) draft.name ??= value;
              else nonLiteral = true;
            } else if (key === 'install_requires') {
              if (Array.isArray(value)) for (const req of value) typeof req === 'string' && declare(draft, req, 'dependencies', path);
              else nonLiteral = true;
            } else if (key === 'extras_require') {
              const extras = record(value);
              if (extras) for (const k of Object.keys(extras)) for (const req of strings(extras[k])) declare(draft, req, 'optionalDependencies', path);
              else nonLiteral = true;
            } else if (key === 'package_dir') {
              const dirs = record(value);
              if (!dirs) {
                nonLiteral = true;
                continue;
              }
              for (const k of Object.keys(dirs)) {
                const dir = dirs[k];
                if (typeof dir !== 'string') continue;
                const joined = joinRoot(draft.root, dir);
                if (joined === null) continue;
                if (k === '') draft.explicitRoots.push(joined);
                else draft.packageDirs.set(k, joined);
              }
            }
          }
          if (nonLiteral) warn('SETUP_PY_NONLITERAL');
        }
      }
      for (const child of node.namedChildren) if (child) stack.push(child);
    }
    if (!found) warn('SETUP_PY_NO_SETUP_CALL');
  } finally {
    tree.delete();
  }
}

function readRequirements(draft: Draft, path: string, text: string, byPath: Map<string, string | null>, seen: Set<string>): void {
  if (seen.has(path) || seen.size > 50) return;
  seen.add(path);
  const dev = /(?:^|[-_.])(?:dev|test|tests|lint|docs?|ci|typing)(?:[-_.]|$)/i.test(repoBasename(path).replace(/\.(txt|in)$/i, ''));
  const field: DependencyField = dev ? 'devDependencies' : 'dependencies';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const include = /^(?:-r|--requirement)\s+(\S+)/.exec(line);
    if (include) {
      const target = joinRoot(repoDirname(path), include[1]!);
      const nested = target === null ? null : byPath.get(target);
      if (target && typeof nested === 'string') readRequirements(draft, target, nested, byPath, seen);
      continue;
    }
    if (line.startsWith('-') || line.includes('://')) continue;
    declare(draft, line, field, path);
  }
}

/** One path segment against a glob segment (`*`, `?`), two pointers: never backtracks exponentially. */
function segmentMatches(pattern: string, text: string): boolean {
  let p = 0,
    t = 0,
    star = -1,
    resume = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === '?' || (pattern[p] !== '*' && pattern[p] === text[t]))) {
      p++;
      t++;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** uv workspace member globs (`packages/*`, `libs/**`), matched segment by segment. */
export function memberMatches(pattern: string, path: string): boolean {
  if (pattern.length > 256) return false;
  const segments = pattern.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
  const parts = path === '' ? [] : path.split('/');
  let reach = new Uint8Array(parts.length + 1);
  reach[0] = 1;
  for (const segment of segments) {
    const next = new Uint8Array(parts.length + 1);
    for (let j = 0; j <= parts.length; j++) {
      if (!reach[j]) continue;
      if (segment === '**') for (let k = j; k <= parts.length; k++) next[k] = 1;
      else if (j < parts.length && segmentMatches(segment, parts[j]!)) next[j + 1] = 1;
    }
    reach = next;
  }
  return reach[parts.length] === 1;
}

export function discoverPythonProjects(files: readonly ProjectFile[], hasDirectoryWithPython: (dir: string) => boolean): ProjectDiscovery {
  const warnings: ProjectDiscovery['warnings'] = [];
  const byPath = new Map(files.map((f) => [f.path, f.text] as const));
  const drafts = new Map<string, Draft>();
  const manifests = files.filter((f) => isPythonManifest(f.path) && !FIXTURE_SEGMENT.test(repoDirname(f.path))).sort((a, b) => compareUtf8(a.path, b.path));
  for (const file of manifests) {
    const warn = (code: string) => warnings.push({ code, path: file.path });
    if (file.text === null || file.text.length > MAX_MANIFEST_BYTES) {
      warn('PYTHON_MANIFEST_UNREADABLE');
      continue;
    }
    const root = repoDirname(file.path);
    const draft = draftFor(drafts, root);
    const base = repoBasename(file.path);
    if (base === 'pyproject.toml') readPyproject(draft, file.path, file.text, warn);
    else if (base === 'setup.cfg') readSetupCfg(draft, file.path, file.text);
    else if (base === 'setup.py') readSetupPy(draft, file.path, file.text, warn);
    else if (base === 'Pipfile') {
      try {
        const doc = parseToml(file.text) as Record<string, unknown>;
        draft.manifestPath ??= file.path;
        declareTable(draft, own(doc, 'packages'), 'dependencies', file.path);
        declareTable(draft, own(doc, 'dev-packages'), 'devDependencies', file.path);
      } catch {
        warn('PIPFILE_INVALID');
      }
    } else {
      draft.manifestPath ??= file.path;
      readRequirements(draft, file.path, file.text, byPath, new Set());
    }
  }
  const rootDraft = drafts.get('');
  const members = rootDraft?.workspaceMembers ?? [];
  const projects: PythonProject[] = [...drafts.values()]
    .map((d) => {
      // Like setuptools' automatic discovery: the src layout when src/ holds Python, else flat.
      const src = joinRoot(d.root, 'src')!;
      const conventional = hasDirectoryWithPython(src) ? [src] : [d.root];
      const sourceRoots = [...new Set(d.explicitRoots.length > 0 ? d.explicitRoots : conventional)];
      return {
        root: d.root,
        name: d.name,
        normalizedName: d.name === null ? null : normalizeDistribution(d.name),
        manifestPath: d.manifestPath ?? `${d.root ? `${d.root}/` : ''}pyproject.toml`,
        sourceRoots: sourceRoots.length > 0 ? sourceRoots : [d.root],
        packageDirs: d.packageDirs,
        dependencies: new Map([...d.dependencies].sort(([a], [b]) => compareUtf8(a, b))),
        workspace: d.root === '' || members.some((m) => memberMatches(m, d.root)),
      };
    })
    .sort((a, b) => compareUtf8(a.root, b.root));
  // Two projects claiming one name make imports of it ambiguous.
  const names = new Map<string, number>();
  for (const p of projects) if (p.normalizedName) names.set(p.normalizedName, (names.get(p.normalizedName) ?? 0) + 1);
  for (const p of projects) if (p.normalizedName && names.get(p.normalizedName)! > 1) warnings.push({ code: 'PYTHON_PROJECT_NAME_DUPLICATED', path: p.manifestPath });
  return { projects, warnings };
}

/** The project that owns a path: the deepest project root containing it. */
export function owningProject(projects: readonly PythonProject[], path: string): PythonProject | null {
  let best: PythonProject | null = null;
  for (const p of projects) if (isWithinRepoPath(path, p.root) && (!best || p.root.length > best.root.length)) best = p;
  return best;
}
