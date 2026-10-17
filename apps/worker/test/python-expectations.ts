import { expect } from 'vitest';
import { loadArtifact, gunzipNode } from '@atlas/artifact/node';
import { PYTHON_DEMO_HEAD_FILES, PYTHON_DEMO_IMPORTS } from '@atlas/test-fixtures';
import type { ArtifactBundle } from '@atlas/schema';
import { chunkIdOf, type PublicationStore } from '@atlas/control';

export async function readPythonPublication(publications: PublicationStore, analysisId: string): Promise<ArtifactBundle> {
  const manifest = await publications.manifest(analysisId);
  const loaded = await loadArtifact({ read: async (path, maxBytes) => {
    const bytes = path === 'manifest.json' ? new TextEncoder().encode(JSON.stringify(manifest))
      : await publications.chunk(analysisId, chunkIdOf(path));
    expect(bytes.byteLength).toBeLessThanOrEqual(maxBytes);
    return bytes;
  } }, gunzipNode);
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.issues));
  return loaded.bundle;
}

/** All expectations originate in the authored fixture/ADR policy, never analyzer goldens. */
export function expectPythonBundle(bundle: ArtifactBundle): void {
  expect(bundle.graphs).toHaveLength(2);
  const graph = bundle.graphs.at(-1)!;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const files = graph.nodes.filter((node) => node.kind === 'file');
  expect(files.map((node) => node.path).sort()).toEqual([...PYTHON_DEMO_HEAD_FILES].sort());
  expect(files.filter((node) => node.language === 'python')).toHaveLength(5);
  expect(graph.coverage).toMatchObject({ includedFiles: 8, parsedFiles: 5, parseFailedFiles: 0, observedImports: 7, internalResolved: 3, externalResolved: 1, builtinResolved: 3, unresolved: 0, unsupported: 0 });
  const observations = graph.importObservations.map((obs) => {
    const source = nodes.get(obs.sourceId)!;
    const target = nodes.get(obs.targetId!)!;
    const key = target.kind === 'file' ? target.path : target.kind === 'builtin' ? `builtin:${target.moduleName}` : target.kind === 'external-package' ? `${target.ecosystem}:${target.packageName}` : 'unexpected';
    return [source.kind === 'file' ? source.path : 'unexpected', obs.specifier, obs.kind, key].join('|');
  });
  expect(observations.sort()).toEqual(PYTHON_DEMO_IMPORTS.map((row) => row.join('|')).sort());
  const external = graph.nodes.filter((node) => node.kind === 'external-package');
  expect(external).toHaveLength(1);
  expect(external[0]).toMatchObject({ ecosystem: 'pypi', packageName: 'requests' });
  const pricing = files.find((node) => node.path === 'src/harbor_py/pricing.py')!;
  expect(graph.metrics.find((metric) => metric.nodeId === pricing.id)).toMatchObject({ maxCyclomatic: 2, callableCount: 1, fanIn: 1, fanOut: 1 });
  expect(graph.diagnostics).toEqual([]);
  const previous = bundle.graphs[0]!;
  const before = previous.nodes.find((node) => node.kind === 'file' && node.path === 'src/harbor_py/rules.py');
  const after = files.find((node) => node.path === 'src/harbor_py/policy.py');
  expect(before).toMatchObject({ kind: 'file', path: 'src/harbor_py/rules.py' });
  expect(after).toMatchObject({ kind: 'file', path: 'src/harbor_py/policy.py' });
  expect(after?.lineageId).toBeTypeOf('string');
  expect(before?.kind === 'file' && before.lineageId).toBe(after?.lineageId);
}
