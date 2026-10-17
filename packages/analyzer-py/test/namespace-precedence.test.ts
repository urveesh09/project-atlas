import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { PathIndex, PythonResolver, extractPythonFacts, initPythonParser, type PythonProject } from '@atlas/analyzer-py';

const roots = ['early', 'late'];
const project: PythonProject = { root: '', name: 'fixture', normalizedName: 'fixture', manifestPath: 'pyproject.toml', sourceRoots: roots, packageDirs: new Map(), dependencies: new Map(), workspace: true };
beforeAll(initPythonParser);
function resolve(files: string[], code: string) {
  const resolver = new PythonResolver(new PathIndex(['app/main.py', ...files]), [project]);
  const facts = extractPythonFacts('app/main.py', code);
  expect(facts.parseStatus).toBe('parsed');
  return facts.imports.flatMap((imp) => resolver.resolveAll('app/main.py', imp));
}

const cases = [
  { name: 'a later regular package supersedes an earlier namespace', files: ['early/demo/portion.py', 'late/demo/__init__.py'], module: 'demo', target: 'late/demo/__init__.py' },
  { name: 'a later module supersedes an earlier namespace', files: ['early/demo/portion.py', 'late/demo.py'], module: 'demo', target: 'late/demo.py' },
  { name: 'namespace portions contribute a submodule from the later root', files: ['early/demo/first.py', 'late/demo/second.py'], module: 'demo.second', target: 'late/demo/second.py' },
  { name: 'a regular parent prevents a discarded namespace supplying a child', files: ['early/demo/ghost.py', 'late/demo/__init__.py'], module: 'demo.ghost', target: null },
  { name: 'a module cannot acquire children from a later package', files: ['early/demo.py', 'late/demo/__init__.py', 'late/demo/child.py'], module: 'demo.child', target: null },
  { name: 'nested regular packages supersede namespace portions', files: ['early/demo/sub/ghost.py', 'late/demo/sub/__init__.py'], module: 'demo.sub', target: 'late/demo/sub/__init__.py' },
] as const;

it.each(cases)('$name (PEP 420)', ({ files, module, target }) => {
  const result = resolve([...files], `import ${module}\n`);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject(target === null
    ? { status: 'unresolved', targetPath: null, reasonCode: 'LOCAL_TARGET_MISSING' }
    : { status: 'resolved-internal', targetPath: target, confidence: 'exact' });
});

it('from-imports search every surviving namespace portion and keep source ranges', () => {
  const result = resolve(['early/demo/first.py', 'late/demo/second.py'], 'from demo import first, second\n');
  expect(result.map((r) => [r.specifier, r.status, r.targetPath, r.confidence])).toEqual([
    ['demo.first', 'resolved-internal', 'early/demo/first.py', 'exact'],
    ['demo.second', 'resolved-internal', 'late/demo/second.py', 'exact'],
  ]);
  expect(result.map((r) => r.range.startColumn)).toEqual([18, 25]);
});

it('from-imports use a later regular package rather than discarded namespace names', () => {
  const result = resolve(['early/demo/ghost.py', 'late/demo/__init__.py'], 'from demo import Export\n');
  expect(result.map((r) => [r.specifier, r.status, r.targetPath])).toEqual([['demo', 'resolved-internal', 'late/demo/__init__.py']]);
});

const python = (() => { try { execFileSync('python', ['-I', '-c', 'import sys; assert sys.version_info >= (3,10)'], { windowsHide: true, timeout: 10_000, stdio: 'pipe' }); return true; } catch { return false; } })();
it.skipIf(!python)('independent CPython PathFinder agrees without importing or executing any fixture module', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-namespace-oracle-'));
  try {
    const authored = cases.map((row, index) => {
      const dir = path.join(root, String(index));
      for (const name of row.files) {
        const file = path.join(dir, name);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '# Authored lookup-only fixture. Never imported.\n');
      }
      return { dir, module: row.module, target: row.target };
    });
    const script = [
      'import json, os, sys',
      'from importlib.machinery import PathFinder',
      'results = []',
      'for case in json.loads(sys.stdin.read()):',
      '    search = [os.path.join(case["dir"], r) for r in ("early", "late")]',
      '    spec = None',
      '    for index, part in enumerate(case["module"].split(".")):',
      '        spec = PathFinder.find_spec(".".join(case["module"].split(".")[:index+1]), search)',
      '        if spec is None: break',
      '        search = spec.submodule_search_locations',
      '        if index < len(case["module"].split("."))-1 and search is None:',
      '            spec = None',
      '            break',
      '    results.append(None if spec is None or spec.origin is None else os.path.relpath(spec.origin, case["dir"]).replace(os.sep, "/"))',
      'print(json.dumps(results))',
    ].join('\n');
    const actual: unknown = JSON.parse(execFileSync('python', ['-I', '-S', '-c', script], { input: JSON.stringify(authored), encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
    expect(actual).toEqual(cases.map((row) => row.target));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
