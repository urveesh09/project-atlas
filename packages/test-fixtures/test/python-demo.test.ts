import { expect, it } from 'vitest';
import { buildPythonDemoRepository, PYTHON_DEMO_HEAD_FILES, PYTHON_DEMO_IMPORTS } from '../src/index.js';

it('creates the authored Python history and pure rename without executing its files', () => {
  const fixture = buildPythonDemoRepository();
  try {
    expect(fixture.commits).toHaveLength(2);
    const paths = fixture.git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort();
    expect(paths).toEqual([...PYTHON_DEMO_HEAD_FILES].sort());
    const oldPolicy = fixture.git(['show', `${fixture.commits[0]}:src/harbor_py/rules.py`]);
    const newPolicy = fixture.git(['show', `${fixture.commits[1]}:src/harbor_py/policy.py`]);
    expect(oldPolicy).toBe(newPolicy);
    expect(PYTHON_DEMO_IMPORTS).toHaveLength(7);
    expect(fixture.git(['show', 'HEAD:pyproject.toml'])).toContain('requests>=2.31');
  } finally { fixture.dispose(); }
});
