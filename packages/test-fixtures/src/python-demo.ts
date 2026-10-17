import { createGitFixture, type GitFixture } from './git-fixture.js';

/** Authored before analysis: eight files, five Python sources, seven import statements. */
export const PYTHON_DEMO_HEAD_FILES = [
  '.gitignore', 'README.md', 'pyproject.toml', 'src/harbor_py/__init__.py',
  'src/harbor_py/pricing.py', 'src/harbor_py/policy.py', 'src/harbor_py/types.pyi', 'tests/test_pricing.py',
] as const;
export const PYTHON_DEMO_IMPORTS = [
  ['src/harbor_py/__init__.py', '.pricing', 'reexports-value', 'src/harbor_py/pricing.py'],
  ['src/harbor_py/pricing.py', 'decimal', 'imports-value', 'builtin:decimal'],
  ['src/harbor_py/pricing.py', '.policy', 'imports-value', 'src/harbor_py/policy.py'],
  ['src/harbor_py/pricing.py', 'requests', 'imports-value', 'pypi:requests'],
  ['src/harbor_py/policy.py', 'decimal', 'imports-value', 'builtin:decimal'],
  ['src/harbor_py/types.pyi', 'decimal', 'imports-type', 'builtin:decimal'],
  ['tests/test_pricing.py', 'harbor_py', 'imports-value', 'src/harbor_py/__init__.py'],
] as const;

const pricing = (module: string) => `from decimal import Decimal\nfrom .${module} import rate\nimport requests\n\ndef quote(amount: int) -> Decimal:\n    if amount < 0:\n        raise ValueError("negative amount")\n    return Decimal(amount) * rate()\n`;
const policy = (value: string) => `from decimal import Decimal\n\ndef rate() -> Decimal:\n    return Decimal("${value}")\n`;

export function buildPythonDemoRepository(options: { parent?: string } = {}): GitFixture {
  return createGitFixture([
    { date: '2026-10-01T10:00:00Z', message: 'authored Python service', files: {
      '.gitignore': '__pycache__/\n.venv/\n',
      'README.md': '# Harbor Python\nAuthored static-analysis fixture; never installed or executed.\n',
      'pyproject.toml': '[project]\nname = "harbor-python"\nversion = "1.0.0"\ndependencies = ["requests>=2.31"]\n[tool.setuptools.packages.find]\nwhere = ["src"]\n',
      'src/harbor_py/__init__.py': 'from .pricing import quote as quote\n',
      'src/harbor_py/pricing.py': pricing('rules'),
      'src/harbor_py/rules.py': policy('1.20'),
      'src/harbor_py/types.pyi': 'from decimal import Decimal\n\ndef quote(amount: int) -> Decimal: ...\n',
      'tests/test_pricing.py': 'from harbor_py import quote\n\ndef test_quote():\n    assert quote(10) == 12\n',
    } },
    { date: '2026-10-02T10:00:00Z', message: 'rename pricing policy', renames: [['src/harbor_py/rules.py', 'src/harbor_py/policy.py']], files: {
      'src/harbor_py/pricing.py': pricing('policy'),
    } },
  ], options);
}
