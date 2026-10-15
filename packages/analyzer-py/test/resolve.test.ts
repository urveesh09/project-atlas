import { beforeAll, describe, expect, it } from 'vitest';
import {
  PathIndex,
  PythonResolver,
  discoverPythonProjects,
  distributionCandidates,
  extractPythonFacts,
  initPythonParser,
  memberMatches,
  normalizeDistribution,
  parseRequirement,
  type PyResolution,
} from '@atlas/analyzer-py';

/** A monorepo exercising every resolution rule of ADR-057. */
const FILES: Record<string, string> = {
  'pyproject.toml': [
    '[project]',
    'name = "acme"',
    'dependencies = ["requests>=2", "PyYAML", "google-cloud-storage==2.0"]',
    '[project.optional-dependencies]',
    'dev = ["pytest"]',
    '[tool.uv.workspace]',
    'members = ["libs/*"]',
    '[tool.setuptools.packages.find]',
    'where = ["src"]',
    '',
  ].join('\n'),
  'src/acme/__init__.py': 'from .core import run\n__all__ = ["run"]\n',
  'src/acme/core.py': '',
  'src/acme/logging.py': '',
  'src/acme/types.pyi': '',
  'src/acme/util/__init__.py': '',
  'src/acme/util/text.py': '',
  'src/acme/_ns/thing.py': '',
  'tests/test_core.py': '',
  'scripts/tool.py': '',
  'scripts/helpers.py': '',
  'scripts/logging.py': '',
  'libs/shared/pyproject.toml': '[project]\nname = "acme-shared"\ndependencies = ["numpy"]\n',
  'libs/shared/src/shared/__init__.py': '',
  'services/api/requirements.txt': 'flask==3.0  # web\n-r ../../requirements-dev.txt\n--index-url https://example.invalid\n',
  'requirements-dev.txt': 'pytest\nblack>=24 ; python_version >= "3.10"\n',
  'services/api/app.py': '',
  'legacy/setup.py': 'from setuptools import setup\nsetup(name="legacy", package_dir={"": "lib"}, install_requires=["six>=1.16"])\n',
  'legacy/lib/old/__init__.py': '',
  'legacy/run.py': '',
  'tests/fixtures/sample/pyproject.toml': '[project]\nname = "sample"\n',
};
const EXCLUDED = ['src/acme/generated.py'];

let resolver: PythonResolver;
let projects: ReturnType<typeof discoverPythonProjects>;
beforeAll(async () => {
  await initPythonParser();
  const index = new PathIndex(Object.keys(FILES), EXCLUDED);
  projects = discoverPythonProjects(
    Object.entries(FILES).map(([path, text]) => ({ path, text })),
    (dir) => Object.keys(FILES).some((p) => p.endsWith('.py') && (dir === '' || p.startsWith(`${dir}/`))),
  );
  resolver = new PythonResolver(index, projects.projects);
});

/** Resolve every import in `code` as if it were written in `path`. */
function resolve(path: string, code: string): Pick<PyResolution, 'status' | 'kind' | 'specifier' | 'targetPath' | 'externalName' | 'confidence' | 'reasonCode'>[] {
  const facts = extractPythonFacts(path, code);
  expect(facts.parseStatus).toBe('parsed');
  return facts.imports.flatMap((imp) => resolver.resolveAll(path, imp)).map(({ status, kind, specifier, targetPath, externalName, confidence, reasonCode }) => ({ status, kind, specifier, targetPath, externalName, confidence, reasonCode }));
}
const internal = (specifier: string, targetPath: string, confidence = 'exact', reasonCode: string | null = null, kind = 'imports-value') => ({ status: 'resolved-internal', kind, specifier, targetPath, externalName: null, confidence, reasonCode });

describe('Python projects (ADR-057)', () => {
  it('discovers projects, roots, workspace members and declared dependencies, ignoring fixtures', () => {
    const summary = projects.projects.map((p) => ({ root: p.root, name: p.name, roots: p.sourceRoots, workspace: p.workspace, deps: [...p.dependencies.keys()] }));
    expect(summary).toEqual([
      { root: '', name: 'acme', roots: ['src'], workspace: true, deps: ['black', 'google-cloud-storage', 'pytest', 'pyyaml', 'requests'] },
      { root: 'legacy', name: 'legacy', roots: ['legacy/lib'], workspace: false, deps: ['six'] },
      { root: 'libs/shared', name: 'acme-shared', roots: ['libs/shared/src'], workspace: true, deps: ['numpy'] },
      { root: 'services/api', name: null, roots: ['services/api'], workspace: false, deps: ['black', 'flask', 'pytest'] },
    ]);
    const root = projects.projects[0]!;
    expect(root.dependencies.get('requests')).toEqual([{ field: 'dependencies', range: '>=2', manifestPath: 'pyproject.toml' }]);
    expect(root.dependencies.get('pytest')).toEqual([
      { field: 'optionalDependencies', range: '*', manifestPath: 'pyproject.toml' },
      { field: 'devDependencies', range: '*', manifestPath: 'requirements-dev.txt' },
    ]);
    const api = projects.projects[3]!;
    expect(api.dependencies.get('flask')).toEqual([{ field: 'dependencies', range: '==3.0', manifestPath: 'services/api/requirements.txt' }]);
    expect(api.dependencies.get('black')).toEqual([{ field: 'devDependencies', range: '>=24', manifestPath: 'requirements-dev.txt' }]);
  });

  it('parses requirements, normalizes names and matches workspace globs', () => {
    expect(parseRequirement('Django[argon2] >= 4.2, <5 ; python_version >= "3.10"  # web')).toEqual({ name: 'Django', range: '>=4.2,<5' });
    expect(parseRequirement('pkg @ https://example.invalid/pkg.whl')).toEqual({ name: 'pkg', range: 'url' });
    expect(parseRequirement('-e .')).toBeNull();
    expect(normalizeDistribution('Zope.Interface__x')).toBe('zope-interface-x');
    expect(memberMatches('libs/*', 'libs/shared')).toBe(true);
    expect(memberMatches('libs/*', 'libs/a/b')).toBe(false);
    expect(memberMatches('packages/**', 'packages/a/b')).toBe(true);
    expect(memberMatches(`${'*'.repeat(200)}x`, 'a'.repeat(200))).toBe(false);
    expect(distributionCandidates('google.cloud.storage.blob')[0]).toBe('google-cloud-storage-blob');
    expect(distributionCandidates('google.protobuf.message')[0]).toBe('protobuf');
    expect(distributionCandidates('yaml')).toEqual(['pyyaml', 'yaml']);
  });

  it('scans manifest lines in linear time (CodeQL js/polynomial-redos)', () => {
    // Each input took quadratic time with the earlier backtracking patterns.
    expect(parseRequirement(`a${' '.repeat(200_000)}x`)).toBeNull();
    expect(parseRequirement(`0${' '.repeat(200_000)}>=1`)).toEqual({ name: '0', range: '>=1' });
    expect(parseRequirement(' #'.repeat(100_000))).toBeNull();
    expect(parseRequirement(`x [${'e'.repeat(501)}] >=1`)).toBeNull();
    expect(parseRequirement('_x>=1')).toBeNull();
    expect(distributionCandidates(`a${'_'.repeat(200_000)}a`).at(-1)).toBe('a-a');
    expect(distributionCandidates('__main__')).toEqual(['main']);
    expect(distributionCandidates('___')).toEqual(['-']);
  });

  it('reads only literals from setup.py and warns about the rest', () => {
    const found = discoverPythonProjects([{ path: 'x/setup.py', text: 'from setuptools import setup\nsetup(name=NAME, install_requires=reqs())\n' }], () => true);
    expect(found.projects[0]!.name).toBeNull();
    expect(found.warnings).toEqual([{ code: 'SETUP_PY_NONLITERAL', path: 'x/setup.py' }]);
    const bad = discoverPythonProjects([{ path: 'pyproject.toml', text: '[project\nname=' }], () => true);
    expect(bad.warnings).toEqual([{ code: 'PYPROJECT_INVALID', path: 'pyproject.toml' }]);
  });
});

describe('Python resolution (ADR-057)', () => {
  it('resolves relative imports exactly, including submodules named in from-imports', () => {
    expect(resolve('src/acme/core.py', 'from . import util\nfrom .util.text import slug\n')).toEqual([
      internal('.', 'src/acme/__init__.py'),
      internal('.util', 'src/acme/util/__init__.py'),
      internal('.util.text', 'src/acme/util/text.py'),
    ]);
  });

  it('keeps package-local modules from shadowing the standard library, but a script directory does', () => {
    expect(resolve('src/acme/core.py', 'import logging\nimport os.path\n')).toEqual([
      { status: 'builtin', kind: 'imports-value', specifier: 'logging', targetPath: null, externalName: 'logging', confidence: 'exact', reasonCode: null },
      { status: 'builtin', kind: 'imports-value', specifier: 'os.path', targetPath: null, externalName: 'os', confidence: 'exact', reasonCode: null },
    ]);
    expect(resolve('scripts/tool.py', 'import helpers\nimport logging\n')).toEqual([internal('helpers', 'scripts/helpers.py'), internal('logging', 'scripts/logging.py', 'inferred', 'STDLIB_SHADOWED')]);
  });

  it('finds the project package from tests through its source root, and other projects as inferred', () => {
    expect(resolve('tests/test_core.py', 'import acme.core\nfrom acme import util\n')).toEqual([
      internal('acme.core', 'src/acme/core.py'),
      internal('acme', 'src/acme/__init__.py'),
      internal('acme.util', 'src/acme/util/__init__.py'),
    ]);
    expect(resolve('services/api/app.py', 'import shared\n')).toEqual([internal('shared', 'libs/shared/src/shared/__init__.py', 'inferred', 'WORKSPACE_PROJECT_MODULE')]);
    expect(resolve('legacy/run.py', 'import old\n')).toEqual([internal('old', 'legacy/lib/old/__init__.py')]);
  });

  it('resolves external distributions as declared (exact) or undeclared (inferred)', () => {
    const ext = (specifier: string, externalName: string, declared: boolean) => ({ status: 'resolved-external', kind: 'imports-value', specifier, targetPath: null, externalName, confidence: declared ? 'exact' : 'inferred', reasonCode: declared ? null : 'UNDECLARED_EXTERNAL_IMPORT' });
    expect(resolve('services/api/app.py', 'import flask\nimport pytest\nimport yaml\nimport google.cloud.storage\nimport numpy\nimport PIL.Image\n')).toEqual([
      ext('flask', 'flask', true),
      ext('pytest', 'pytest', true),
      ext('yaml', 'pyyaml', true),
      ext('google.cloud.storage', 'google-cloud-storage', true),
      ext('numpy', 'numpy', false),
      ext('PIL.Image', 'pillow', false),
    ]);
  });

  it('reports namespace packages, missing, guarded, excluded, mis-cased and beyond-top-level targets', () => {
    expect(resolve('src/acme/core.py', 'from acme._ns import thing\nimport acme._ns\n')).toEqual([
      internal('acme._ns.thing', 'src/acme/_ns/thing.py'),
      { status: 'unsupported', kind: 'imports-value', specifier: 'acme._ns', targetPath: null, externalName: null, confidence: null, reasonCode: 'NAMESPACE_PACKAGE' },
    ]);
    const statuses = (path: string, code: string) => resolve(path, code).map((r) => [r.specifier, r.status, r.reasonCode]);
    expect(statuses('src/acme/core.py', 'from .missing import x\ntry:\n    from .optional import y\nexcept ImportError:\n    y = None\nfrom . import generated\nfrom .Util import text\nfrom .. import outside\n')).toEqual([
      ['.missing', 'unresolved', 'LOCAL_TARGET_MISSING'],
      ['.optional', 'unresolved', 'OPTIONAL_TARGET_MISSING'],
      ['.', 'resolved-internal', null],
      ['.generated', 'excluded-target', 'TARGET_EXCLUDED'],
      ['.Util', 'unresolved', 'CASE_MISMATCH'],
      ['..', 'unresolved', 'RELATIVE_BEYOND_TOP_LEVEL'],
    ]);
  });

  it('keeps a missing submodule of a local package local, and names other runtimes honestly (found on pip)', () => {
    const statuses = (code: string) => resolve('src/acme/core.py', code).map((r) => [r.specifier, r.status, r.externalName, r.reasonCode]);
    expect(statuses('import acme.gone\nimport urllib2\nimport __pypy__\nfrom _typeshed import StrPath\nimport _distutils_hack\ntry:\n    import simplejson\nexcept ImportError:\n    simplejson = None\n')).toEqual([
      ['acme.gone', 'unresolved', null, 'LOCAL_TARGET_MISSING'],
      ['urllib2', 'builtin', 'urllib2', 'PYTHON2_STDLIB'],
      ['__pypy__', 'builtin', '__pypy__', 'PYPY_BUILTIN'],
      ['_typeshed', 'builtin', '_typeshed', 'TYPESHED_ONLY'],
      ['_distutils_hack', 'resolved-external', 'setuptools', 'UNDECLARED_EXTERNAL_IMPORT'],
      ['simplejson', 'resolved-external', 'simplejson', 'OPTIONAL_EXTERNAL_IMPORT'],
    ]);
  });

  it('types imports of stubs, and resolves literal dynamic imports through the same rules', () => {
    expect(resolve('src/acme/core.py', 'from .types import T\n')).toEqual([internal('.types', 'src/acme/types.pyi', 'exact', null, 'imports-type')]);
    const dynamic = resolve('src/acme/core.py', 'import importlib\nm = importlib.import_module("acme.util.text")\nr = importlib.import_module(".util", package=__package__)\n');
    expect(dynamic.slice(1).map((r) => [r.kind, r.targetPath, r.confidence])).toEqual([
      ['imports-dynamic-literal', 'src/acme/util/text.py', 'exact'],
      ['imports-dynamic-literal', 'src/acme/util/__init__.py', 'exact'],
    ]);
  });
});
