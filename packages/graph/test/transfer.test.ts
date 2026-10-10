import { expect, it } from 'vitest';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import { GraphIndex } from '@atlas/graph';

it('restores worker-prepared indexes after a real structured clone without rebuilding them', () => {
  const { graph } = buildHandcraftedArtifact(),
    original = new GraphIndex(graph);
  const copy = structuredClone({ graph, data: original.transferData() }),
    restored = new GraphIndex(copy.graph, copy.data);
  expect(restored.nodes).toBe(copy.data.nodes);
  for (const n of graph.nodes) {
    expect(restored.outgoing(n.id)).toEqual(original.outgoing(n.id));
    expect(restored.incoming(n.id)).toEqual(original.incoming(n.id));
    expect(restored.observationsFrom(n.id)).toEqual(original.observationsFrom(n.id));
    expect(restored.ancestors(n.id)).toEqual(original.ancestors(n.id));
    expect(restored.packageOf(n.id)).toEqual(original.packageOf(n.id));
  }
  expect(restored.packageRollups()).toEqual(original.packageRollups());
});
