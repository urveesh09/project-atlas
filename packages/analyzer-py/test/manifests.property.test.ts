import fc from 'fast-check';
import { expect, it } from 'vitest';
import { discoverPythonProjects, normalizeDistribution } from '@atlas/analyzer-py';
import { LIMITS } from '@atlas/schema';

const parameters = { seed: 0x50594d32, numRuns: 100 };
const manifests = ['pyproject.toml', 'requirements.txt', 'setup.cfg', 'Pipfile'] as const;
const name = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_.-]{0,8}[A-Za-z0-9]$/);

it.each(manifests)('%s recovers independently generated literal dependency declarations', (path) => {
  fc.assert(fc.property(fc.uniqueArray(name, { minLength: 1, maxLength: 12, selector: normalizeDistribution }), (names) => {
    const text = path === 'pyproject.toml' ? `[project]\nname="authored"\ndependencies=${JSON.stringify(names.map((n) => `${n}>=1`))}\n`
      : path === 'requirements.txt' ? names.map((n) => `${n}>=1 # authored`).join('\n')
      : path === 'setup.cfg' ? `[options]\ninstall_requires =\n${names.map((n) => `    ${n}>=1`).join('\n')}\n`
      : `[packages]\n${names.map((n) => `${JSON.stringify(n)} = ">=1"`).join('\n')}\n`;
    const result = discoverPythonProjects([{ path, text }], () => false);
    expect(result.warnings).toEqual([]);
    expect(result.projects).toHaveLength(1);
    const dependencies = result.projects[0]!.dependencies;
    expect([...dependencies.keys()].sort()).toEqual(names.map(normalizeDistribution).sort());
    for (const declarations of dependencies.values()) expect(declarations).toEqual([{ field: 'dependencies', range: '>=1', manifestPath: path }]);
  }), parameters);
});

it.each(manifests)('%s contains arbitrary text without execution or uncaught parser failures', (path) => {
  const arbitraryText = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 4096 }).map((units) => String.fromCharCode(...units));
  fc.assert(fc.property(arbitraryText, (text) => {
    const result = discoverPythonProjects([{ path, text }], () => false);
    expect(result.projects.length).toBeLessThanOrEqual(1);
    expect(result.warnings.length).toBeLessThanOrEqual(1);
    for (const warning of result.warnings) expect(['PYPROJECT_INVALID', 'PIPFILE_INVALID']).toContain(warning.code);
    expect(Object.hasOwn(Object.prototype, 'atlasPropertyPollution')).toBe(false);
  }), parameters);
});

it.each(manifests)('%s refuses oversized inputs before parsing', (path) => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 256 }), (extra) => {
    const result = discoverPythonProjects([{ path, text: 'x'.repeat(LIMITS.sourceBlobBytes + extra) }], () => false);
    expect(result).toEqual({ projects: [], warnings: [{ code: 'PYTHON_MANIFEST_UNREADABLE', path }] });
  }), { ...parameters, numRuns: 12 });
});

it('requirements include cycles terminate and cannot pull files outside the committed map', () => {
  fc.assert(fc.property(name, (dependency) => {
    const result = discoverPythonProjects([
      { path: 'requirements.txt', text: '-r requirements-dev.txt\n-r ../../outside.txt\n' },
      { path: 'requirements-dev.txt', text: `-r requirements.txt\n${dependency}>=1\n` },
    ], () => false);
    expect(result.projects).toHaveLength(1);
    expect([...result.projects[0]!.dependencies.keys()]).toEqual([normalizeDistribution(dependency)]);
    expect(result.projects[0]!.dependencies.get(normalizeDistribution(dependency))?.every((d) => d.field === 'devDependencies')).toBe(true);
  }), parameters);
});
