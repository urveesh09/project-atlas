import { describe, expect, it } from 'vitest';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';
import { GraphIndex, aggregateEdges } from '@atlas/graph';
import { computeLayout, prepareCity } from '@atlas/layout';
import { nodeId, lineageId, observationId, type FileNode, type ImportObservation } from '@atlas/schema';
import { buildOverlay, type OverlayOptions } from '../src/city/overlay';
import { parseFragment, formatFragment } from '../src/app/state';

const options: OverlayOptions = {
  selectedId: null,
  direction: 'outgoing',
  includeTypes: false,
  pinnedEdgeId: null,
  packages: false,
};
describe('overlay truth and budgets', () => {
  it('promotes a pinned external target while retaining the 50-terminal cap and all graph evidence', () => {
    const f = buildHandcraftedArtifact();
    const main = f.graph.nodes.find((n): n is FileNode => n.kind === 'file' && n.path === 'src/main.ts')!;
    const template = f.graph.nodes.find((n) => n.kind === 'external-package')!;
    if (template.kind !== 'external-package') throw new Error('missing fixture external');
    const external = Array.from({ length: 51 }, (_, i) => {
      const name = `dep${String(i).padStart(2, '0')}`;
      return { ...template, id: nodeId(f.graph.snapshotId, 'external-package', name), label: name, packageName: name };
    });
    const observations = external.map((n, i): ImportObservation => {
      const range = {
        startOffset: i * 10,
        endOffset: i * 10 + 5,
        startLine: i + 1,
        endLine: i + 1,
        startColumn: 1,
        endColumn: 6,
      };
      return {
        id: observationId(f.graph.snapshotId, main.id, 'imports-value', range, n.packageName),
        sourceId: main.id,
        targetId: n.id,
        kind: 'imports-value',
        specifier: n.packageName,
        range,
        status: 'resolved-external',
        confidence: 'exact',
        resolverMode: 'bundler/esm',
        reasonCode: null,
      };
    });
    const graph = {
      ...f.graph,
      nodes: [...f.graph.nodes.filter((n) => n.kind !== 'external-package' && n.kind !== 'builtin'), ...external],
      edges: aggregateEdges(f.graph.snapshotId, observations).edges,
      importObservations: observations,
    };
    const geometry = computeLayout({
      repoId: graph.repoId,
      frameKey: graph.snapshotId,
      externals: external.map((n) => `npm:${n.packageName}`),
      root: { kind: 'repository', path: '', children: [], files: [main.lineageId!] },
    });
    const layout = {
      ...geometry,
      frameState: [
        {
          snapshotId: graph.snapshotId,
          containers: [],
          files: [
            {
              nodeId: main.id,
              lineageId: main.lineageId!,
              currentParentId: main.parentId!,
              height: 1,
              present: true as const,
            },
          ],
        },
      ],
    };
    const city = prepareCity(graph, layout),
      index = new GraphIndex(graph);
    expect(city.terminals).toHaveLength(50);
    expect(city.allTerminals).toHaveLength(51);
    const initial = buildOverlay(index, city, { ...options, selectedId: main.id });
    expect(initial.arcs).toHaveLength(50);
    expect(initial.unplaced).toBe(1);
    const hidden = city.allTerminals.find((t) => !city.terminals.some((v) => v.nodeId === t.nodeId))!;
    const edge = graph.edges.find((e) => e.targetId === hidden.nodeId)!;
    const pinned = buildOverlay(index, city, { ...options, selectedId: main.id, pinnedEdgeId: edge.id });
    expect(pinned.promotedTerminal?.nodeId).toBe(hidden.nodeId);
    expect(pinned.arcs).toHaveLength(50);
    expect(pinned.arcs[0]!.id).toBe(edge.id);
    expect(graph.edges).toHaveLength(51);
    expect(city.terminals).toHaveLength(50);
  });
  it('keeps source→target direction for incoming edges and toggles type policy explicitly', () => {
    const f = buildHandcraftedArtifact(),
      index = new GraphIndex(f.graph),
      city = prepareCity(f.graph, f.layout);
    const main = f.graph.nodes.find((n) => n.kind === 'file' && n.path === 'src/main.ts')!,
      util = f.graph.nodes.find((n) => n.kind === 'file' && n.path === 'src/util.ts')!;
    expect(buildOverlay(index, city, { ...options, selectedId: main.id }).total).toBe(3);
    expect(buildOverlay(index, city, { ...options, selectedId: main.id, direction: 'incoming' }).total).toBe(0);
    const typed = buildOverlay(index, city, {
      ...options,
      selectedId: main.id,
      direction: 'incoming',
      includeTypes: true,
    });
    expect(typed.arcs).toHaveLength(1);
    expect(typed.arcs[0]!.sourceId).toBe(util.id);
    expect(typed.arcs[0]!.targetId).toBe(main.id);
    expect(typed.arcs[0]!.kind).toBe('imports-type');
  });
  it('never invents overview edges when no overlay is requested', () => {
    const f = buildHandcraftedArtifact();
    expect(buildOverlay(new GraphIndex(f.graph), prepareCity(f.graph, f.layout), options).arcs).toEqual([]);
  });
  it('caps a 210-target hub at 200 and lets the user pin an omitted real edge', () => {
    const f = buildHandcraftedArtifact(),
      main = f.graph.nodes.find((n): n is FileNode => n.kind === 'file' && n.path === 'src/main.ts')!;
    const files = Array.from({ length: 210 }, (_, i): FileNode => {
      const path = `src/f${i}.ts`;
      return {
        ...main,
        id: nodeId(f.graph.snapshotId, 'file', path),
        path,
        label: `f${i}.ts`,
        lineageId: lineageId(f.graph.repoId, f.graph.commitOid, f.graph.commitOid, path),
      };
    });
    const observations = files.map((file, i): ImportObservation => {
      const range = {
        startOffset: i * 10,
        endOffset: i * 10 + 5,
        startLine: i + 1,
        endLine: i + 1,
        startColumn: 1,
        endColumn: 6,
      };
      return {
        id: observationId(f.graph.snapshotId, main.id, 'imports-value', range, file.path),
        sourceId: main.id,
        targetId: file.id,
        kind: 'imports-value',
        specifier: file.path,
        range,
        status: 'resolved-internal',
        confidence: 'exact',
        resolverMode: 'bundler/esm',
        reasonCode: null,
      };
    });
    const graph = {
      ...f.graph,
      nodes: [...f.graph.nodes, ...files],
      edges: aggregateEdges(f.graph.snapshotId, observations).edges,
      importObservations: observations,
    };
    const geometry = computeLayout({
      repoId: graph.repoId,
      frameKey: graph.snapshotId,
      externals: [],
      root: { kind: 'repository', path: '', children: [], files: [main.lineageId!, ...files.map((n) => n.lineageId!)] },
    });
    const layout = {
      ...geometry,
      frameState: [
        {
          snapshotId: graph.snapshotId,
          containers: [],
          files: [main, ...files].map((n) => ({
            nodeId: n.id,
            lineageId: n.lineageId!,
            currentParentId: n.parentId!,
            height: 1,
            present: true as const,
          })),
        },
      ],
    };
    const index = new GraphIndex(graph),
      city = prepareCity(graph, layout),
      initial = buildOverlay(index, city, { ...options, selectedId: main.id });
    expect(initial.arcs).toHaveLength(200);
    expect(initial.total).toBe(210);
    expect(initial.omitted).toBe(10);
    const absent = graph.edges.find((e) => !initial.arcs.some((a) => a.id === e.id))!;
    const pinned = buildOverlay(index, city, { ...options, selectedId: main.id, pinnedEdgeId: absent.id });
    expect(pinned.arcs).toHaveLength(200);
    expect(pinned.arcs[0]!.id).toBe(absent.id);
    expect(pinned.omitted).toBe(10);
    expect(graph.edges).toHaveLength(210);
  });
});

describe('bounded view fragments', () => {
  it('round-trips lens/mode/selection and rejects duplicate, executable, unknown and oversized settings', () => {
    const file = `lin_${'a'.repeat(64)}`,
      hash = formatFragment(file, 'dependencies', 'complexity', 'map');
    expect(parseFragment(hash)).toEqual({
      file,
      tab: 'dependencies',
      lens: 'complexity',
      mode: 'map',
      frame: null,
      rejected: false,
    });
    for (const bad of [
      '#v=2',
      '#v=1&lens=hotspot',
      '#mode=javascript:alert(1)',
      '#file=x',
      '#mode=map&mode=3d',
      `#${'a'.repeat(4097)}`,
    ])
      expect(parseFragment(bad).rejected).toBe(true);
    expect(parseFragment(formatFragment(null, 'overview', 'fan-in', 'table')).mode).toBe('table');
  });
});
