import { beforeAll, expect, it } from 'vitest';
import { discoverPythonProjects, initPythonParser } from '@atlas/analyzer-py';

beforeAll(initPythonParser);
it('reads literal setup metadata after nonexecuted code and rejects computed dependencies and escaping roots', () => {
  const found = discoverPythonProjects([{ path: 'setup.py', text: [
    'raise AssertionError("An analyzed setup.py must never execute")',
    'from setuptools import setup',
    'setup(name="safe", install_requires=[name for name in ["requests"]], package_dir={"": "../../outside"})',
  ].join('\n') }], () => false);
  expect(found.warnings).toEqual([{ code: 'SETUP_PY_NONLITERAL', path: 'setup.py' }]);
  expect(found.projects).toHaveLength(1);
  expect(found.projects[0]).toMatchObject({ name: 'safe', sourceRoots: [''] });
  expect([...found.projects[0]!.dependencies]).toEqual([]);
  expect([...found.projects[0]!.packageDirs]).toEqual([]);
});
