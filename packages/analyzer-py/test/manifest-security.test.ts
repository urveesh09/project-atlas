import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { discoverPythonProjects } from '@atlas/analyzer-py';
import { LIMITS } from '@atlas/schema';

it('discovers a full-size, many-key pyproject within one second (GHSA-r4xh-jqrq-34v2)', () => {
  // Production discovery is synchronous in the analyzer parent. Run this adversarial
  // input in a disposable child so a reintroduced stall cannot hang the test runner.
  // Global setup compiles dist/ before this real production-path check (AGENTS.md).
  const entry = new URL('../dist/projects.js', import.meta.url).href;
  const script = `
    import { discoverPythonProjects } from ${JSON.stringify(entry)};
    const cap = ${LIMITS.sourceBlobBytes};
    const header = '[project]\\nname="bounded"\\n[tool]\\n';
    const trailer = '[project.optional-dependencies]\\ncheck=["pytest"]\\n';
    const count = Math.floor((cap - header.length - trailer.length) / 8);
    let text = header + Array.from({ length: count }, (_, i) =>
      'k' + i.toString(36).padStart(4, '0') + '=1\\n').join('') + trailer;
    text += ' '.repeat(cap - text.length);
    const start = performance.now();
    const result = discoverPythonProjects([{ path: 'pyproject.toml', text }], () => true);
    const elapsed = performance.now() - start;
    console.log(JSON.stringify({ elapsed, bytes: Buffer.byteLength(text), keys: count,
      warnings: result.warnings, name: result.projects[0]?.name,
      dependencies: [...(result.projects[0]?.dependencies ?? [])] }));
  `;
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4096, windowsHide: true,
  }));
  expect(report.bytes).toBe(LIMITS.sourceBlobBytes);
  expect(report.keys).toBeGreaterThan(100_000);
  expect(report.warnings).toEqual([]);
  expect(report.name).toBe('bounded');
  expect(report.dependencies).toEqual([
    ['pytest', [{ field: 'optionalDependencies', range: '*', manifestPath: 'pyproject.toml' }]],
  ]);
  expect(report.elapsed, `full-size manifest took ${report.elapsed} ms`).toBeLessThan(1000);
});

it.each(['pyproject.toml', 'Pipfile'])('refuses %s beyond the existing manifest limit', (path) => {
  const found = discoverPythonProjects([{ path, text: ' '.repeat(LIMITS.sourceBlobBytes + 1) }], () => true);
  expect(found.projects).toEqual([]);
  expect(found.warnings).toEqual([{ code: 'PYTHON_MANIFEST_UNREADABLE', path }]);
});

it('reads own TOML tables without trusting prototype-like metadata', () => {
  const found = discoverPythonProjects([
    { path: 'pyproject.toml', text: '[project]\nname="safe"\ndependencies=["requests>=2"]\n[__proto__]\npolluted=true\n' },
    { path: 'Pipfile', text: '[dev-packages]\npytest="*"\n[constructor]\nprototype="ignored"\n' },
  ], () => true);
  expect(found.warnings).toEqual([]);
  expect(found.projects[0]?.name).toBe('safe');
  expect([...found.projects[0]!.dependencies.keys()]).toEqual(['pytest', 'requests']);
  expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
});
