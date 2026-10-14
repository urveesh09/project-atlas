import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { extractPythonFacts, initPythonParser } from '@atlas/analyzer-py';

/**
 * Independent oracle (ADR-056): CPython's own `ast` and `tokenize`, run in isolated mode
 * on files read as data, must agree with ATLAS on every file both parse: import
 * specifiers, module-level declarations, per-callable complexity and code lines. The corpus
 * is the standard library of the Python found on this machine. Without an interpreter the
 * suite is skipped and says so; it never passes vacuously.
 */
const ORACLE = fileURLToPath(new URL('./oracle/ast_oracle.py', import.meta.url));

function findPython(): { command: string; args: string[]; version: string; stdlib: string } | null {
  for (const [command, ...prefix] of [['python3'], ['python'], ['py', '-3']] as const) {
    try {
      const out = execFileSync(command, [...prefix, '-I', '-c', 'import sys, sysconfig; print(".".join(map(str, sys.version_info[:3]))); print(sysconfig.get_paths()["stdlib"])'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20_000 });
      const [version, stdlib] = out.trim().split(/\r?\n/);
      const [major, minor] = version!.split('.').map(Number);
      if (major === 3 && minor! >= 10 && stdlib) return { command, args: [...prefix], version: version!, stdlib };
    } catch {
      // not this one
    }
  }
  return null;
}

function stdlibFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === 'site-packages' || name === '__pycache__' || name === 'dist-packages') continue;
      const full = path.join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else if (name.endsWith('.py') && info.size <= 1_000_000) out.push(full);
    }
  };
  walk(root);
  return out;
}

const python = findPython();
const byLine = (a: [number, string | number | null], b: [number, string | number | null]) => a[0] - b[0] || (String(a[1]) < String(b[1]) ? -1 : String(a[1]) > String(b[1]) ? 1 : 0);

describe.runIf(python !== null)(`CPython oracle on the standard library (${python?.version ?? 'no interpreter'})`, () => {
  beforeAll(async () => {
    await initPythonParser();
  });

  it('agrees on imports, declarations, complexity and code lines for every file both parse', () => {
    const files = stdlibFiles(python!.stdlib);
    const dir = mkdtempSync(path.join(tmpdir(), 'atlas-oracle-'));
    try {
      const list = path.join(dir, 'files.txt');
      writeFileSync(list, files.join('\n'));
      const raw = execFileSync(python!.command, [...python!.args, '-I', ORACLE, list], { encoding: 'utf8', maxBuffer: 1 << 30, timeout: 240_000 });
      const stats = { files: 0, both: 0, onlyCPython: [] as string[], onlyAtlas: 0, mismatches: [] as string[] };
      for (const line of raw.trim().split(/\r?\n/)) {
        const o = JSON.parse(line) as { path: string; parse: boolean | null; imports: [number, string][]; declarations: string[]; complexity: [number, number][]; code_lines: number | null };
        stats.files++;
        if (o.parse === null) continue;
        let bytes = readFileSync(o.path);
        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
        const f = extractPythonFacts(o.path.split(path.sep).join('/'), new TextDecoder().decode(bytes));
        const parsed = f.parseStatus === 'parsed';
        if (o.parse && !parsed) stats.onlyCPython.push(path.relative(python!.stdlib, o.path));
        if (!o.parse && parsed) stats.onlyAtlas++;
        if (!o.parse || !parsed) continue;
        stats.both++;
        const mine = f.imports.filter((i) => i.usage === 'import').map((i) => [i.range.startLine, i.specifier] as [number, string]).sort(byLine);
        if (JSON.stringify(mine) !== JSON.stringify(o.imports.sort(byLine))) stats.mismatches.push(`imports ${o.path}`);
        const counts = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
        const a = counts(f.declarations.map((d) => d.name));
        const b = counts(o.declarations);
        if (![...a].every(([k, v]) => (b.get(k) ?? 0) >= v) || f.declarations.length + f.declarationsOmitted !== o.declarations.length) stats.mismatches.push(`declarations ${o.path}`);
        const complexity = f.callables.map((c) => [c.range.startLine, c.complexity] as [number, number]).sort(byLine);
        if (f.callablesOmitted === 0 && JSON.stringify(complexity) !== JSON.stringify(o.complexity.sort(byLine))) stats.mismatches.push(`complexity ${o.path}`);
        if (o.code_lines !== null && f.codeLines !== o.code_lines) stats.mismatches.push(`code lines ${o.path}: ${f.codeLines} vs ${o.code_lines}`);
      }
      console.info(`CPython ${python!.version} oracle: ${stats.files} files, ${stats.both} parsed by both, ${stats.onlyCPython.length} only by CPython (${stats.onlyCPython.join(', ')}), ${stats.onlyAtlas} only by ATLAS, ${stats.mismatches.length} mismatches`);
      expect(stats.mismatches).toEqual([]);
      expect(stats.both).toBeGreaterThan(500);
      // Grammar gaps for the newest syntax are reported as parse failures; they stay rare.
      expect(stats.onlyCPython.length / stats.both).toBeLessThan(0.01);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

describe.runIf(python === null)('CPython oracle', () => {
  it.skip('skipped: no Python 3.10+ interpreter was found, so the oracle did not run', () => undefined);
});
