import assert from 'node:assert/strict';

export const CAPACITY_LANGUAGES = ['typescript', 'python', 'mixed'];
/**
 * How Python modules render the TS fixture's type-only imports (ADR-067). Class imports are
 * runtime imports, except in one module in four (function number divisible by four), which
 * guards them with TYPE_CHECKING and so also imports typing. Every original statement and
 * target survives, and the edge count stays at the TS fixture's instead of gaining a typing
 * import in every module. Prepared fixtures record it; stale ones are rejected.
 */
export const PYTHON_CAPACITY_POLICY = 'atlas.capacity.python/2';
export function capacityLanguage(value = 'typescript') {
  if (!CAPACITY_LANGUAGES.includes(value)) throw new Error('Language must be typescript, python or mixed');
  return value;
}

/** Transform only our authored synthetic grammar; never translate analyzed repositories. */
export function capacityFiles(files, language = 'typescript') {
  capacityLanguage(language);
  if (language === 'typescript') return files;
  const pythonPackage = (p) => language === 'python' || p % 2 === 0;
  const peer = (p, python) => language === 'mixed' ? p - p % 2 + (python ? 0 : 1) : p;
  const filePath = (file) => {
    const match = /^packages\/p(\d+)\//.exec(file);
    if (!match || !pythonPackage(Number(match[1]))) return file;
    const p = Number(match[1]);
    if (file.endsWith('/package.json')) return file.replace('/package.json', '/pyproject.toml');
    return file.replace('/src/', `/src/p${p}/`).replace(/\/types\.ts$/, '/__init__.pyi').replace(/\/index\.ts$/, '/__init__.py').replace(/\.ts$/, '.py');
  };
  const translate = (file, text) => {
    if (text === null) return null;
    if (language === 'python' && file === 'package.json') return '[tool.uv.workspace]\nmembers = ["packages/*"]\n';
    if (language === 'python' && file === 'tsconfig.json') return '# Authored Python capacity fixture\n';
    const match = /^packages\/p(\d+)\//.exec(file);
    if (!match) return text;
    const p = Number(match[1]);
    if (!pythonPackage(p)) return text.replace(/@bench\/p(\d+)/g, (_, q) => `@bench/p${peer(Number(q), false)}`);
    if (file.endsWith('/package.json')) return `[project]\nname = "bench-p${p}"\nversion = "1.0.0"\ndependencies = ["requests>=2", "pydantic>=2", "rich>=13"]\n[tool.setuptools.packages.find]\nwhere = ["src"]\n`;
    if (file.endsWith('/index.ts')) return 'version = 1\n';
    if (file.endsWith('/types.ts')) return 'class T0:\n    a: int\n';
    assert(file.endsWith('.ts'), `Unexpected synthetic file: ${file}`);
    const lines = text.trimEnd().split('\n');
    const imports = lines.slice(0, 10);
    const guarded = Number(/\/f(\d+)\.ts$/.exec(file)?.[1]) % 4 === 0;
    assert(imports.every((line) => line.startsWith('import ')), 'Expected ten authored import statements');
    const converted = imports.map((line) => {
      let m;
      if ((m = /^import \{ (f\d+) \} from '\.\.\/(m\d+)\/(f\d+)';$/.exec(line))) return `from p${p}.${m[2]}.${m[3]} import ${m[1]}`;
      if ((m = /^import \{ (f\d+) as (g\d+) \} from '@bench\/p(\d+)\/(m\d+)\/(f\d+)';$/.exec(line))) return `from p${peer(Number(m[3]), true)}.${m[4]}.${m[5]} import ${m[1]} as ${m[2]}`;
      if ((m = /^import type \{ (T\d+) \} from '\.\.\/(m\d+)\/types';$/.exec(line))) return `${guarded ? 'if TYPE_CHECKING:\n    ' : ''}from p${p}.${m[2]} import ${m[1]}`;
      if ((m = /^import \* as (ext\d+) from '([^']+)';$/.exec(line))) {
        const external = { react: 'requests', zod: 'pydantic', 'node:fs': 'os', lodash: 'rich' }[m[2]];
        assert(external);
        return `import ${external} as ${m[1]}`;
      }
      throw new Error(`Unexpected authored import: ${line}`);
    });
    const body = lines.slice(10).filter((line) => line !== '}').map((line) => {
      let m;
      if ((m = /^export function (f\d+)\(x: number\): number \{$/.exec(line))) return `def ${m[1]}(x: int) -> int:`;
      if ((m = /^  if \(x > (\d+) && x < (\d+)\) return (\d+);$/.exec(line))) return `    if x > ${m[1]} and x < ${m[2]}:\n        return ${m[3]}`;
      if ((m = /^  return x \? (\d+) : 0;$/.exec(line))) return `    return ${m[1]} if x else 0`;
      throw new Error(`Unexpected authored body: ${line}`);
    });
    // Preserve every authored dependency; import typing only where a guard uses it.
    const typing = converted.some((line) => line.startsWith('if TYPE_CHECKING:')) ? ['from typing import TYPE_CHECKING'] : [];
    return [...typing, ...converted, ...body, ''].join('\n');
  };
  return Object.fromEntries(Object.entries(files).map(([file, text]) => [
    language === 'python' && file === 'package.json' ? 'pyproject.toml' : language === 'python' && file === 'tsconfig.json' ? 'README.md' : filePath(file),
    translate(file, text),
  ]));
}

export function capacityCommits(commits, language) {
  if (capacityLanguage(language) === 'typescript') return commits;
  return commits.map((commit) => ({ ...commit, files: capacityFiles(commit.files, language),
    renames: commit.renames?.map(([from, to]) => {
      // Path transformation is independent of source contents, including deleted files.
      const mapped = capacityFiles({ [from]: null, [to]: null }, language);
      return Object.keys(mapped);
    }),
  }));
}
