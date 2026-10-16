import { describe, expect, it } from 'vitest';
import { codeLabels, nodeIdentityKey, perimeterName, type GraphNode } from '@atlas/schema';

/** Python additions to the graph contract (ADR-060). */
const base = { id: 'x', label: 'x', parentId: null, lineageId: null };
const file = (language: 'typescript' | 'javascript' | 'python' | null) =>
  ({ ...base, kind: 'file', path: 'a', blobOid: 'a'.repeat(40), blobSha256: null, language, role: 'source', byteSize: 1, parseStatus: 'parsed', declarations: null }) as unknown as GraphNode;
const npm = { ...base, kind: 'external-package', ecosystem: 'npm', packageName: 'six', declaredRanges: [] } as GraphNode;
const pypi = { ...base, kind: 'external-package', ecosystem: 'pypi', packageName: 'six', declaredRanges: [] } as GraphNode;
const node = { ...base, kind: 'builtin', moduleName: 'os' } as GraphNode;
const python = { ...base, kind: 'builtin', moduleName: 'os', runtime: 'python' } as GraphNode;

describe('Python in the graph contract (ADR-060)', () => {
  it('keeps npm and Node.js identity keys and gives Python its own', () => {
    expect([npm, pypi, node, python].map(nodeIdentityKey)).toEqual(['six', 'pypi:six', 'os', 'python:os']);
    expect([npm, pypi, node, python].map((n) => perimeterName(n as never))).toEqual(['npm:six', 'pypi:six', 'builtin:os', 'builtin:python:os']);
  });

  it('labels what a snapshot analyzed, keeping the TS/JS wording without Python', () => {
    expect(codeLabels([file('typescript'), npm, node])).toEqual({ code: 'TS/JS', packages: 'npm packages', packagesShort: 'npm', builtins: 'Node.js built-ins', builtinsShort: 'node' });
    expect(codeLabels([])).toMatchObject({ code: 'TS/JS', packages: 'npm packages' });
    expect(codeLabels([file('python'), pypi, python])).toMatchObject({ code: 'Python', packages: 'PyPI packages', builtins: 'Python built-ins' });
    expect(codeLabels([file('javascript'), file('python')])).toMatchObject({ code: 'TS/JS and Python', packages: 'npm and PyPI packages', builtins: 'Node.js and Python built-ins' });
    // A Python file is enough; a Python-only repository need not import anything.
    expect(codeLabels([file('python'), file(null)]).code).toBe('Python');
  });
});
