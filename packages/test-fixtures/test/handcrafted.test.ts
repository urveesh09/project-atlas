import { describe, expect, it } from 'vitest';
import {
  validateGraphSnapshot,
  validateHistoryArtifact,
  validateLayoutArtifact,
  validateManifest,
  type ValidationResult,
} from '@atlas/schema';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';

function codes(result: ValidationResult<unknown>): string[] {
  return result.ok ? [] : result.issues.map((i) => i.code);
}

const clone = <T>(value: T): T => structuredClone(value);

describe('handcrafted artifact (P0.5 gate)', () => {
  const artifact = buildHandcraftedArtifact();

  it('validates every chunk', () => {
    for (const [name, result] of [
      ['graph', validateGraphSnapshot(artifact.graph, { objectFormat: 'sha1' })],
      ['history', validateHistoryArtifact(artifact.history)],
      ['layout', validateLayoutArtifact(artifact.layout)],
      ['manifest', validateManifest(artifact.manifest)],
    ] as const) {
      expect(result.ok ? [] : result.issues, name).toEqual([]);
    }
  });

  it('is deterministic', () => {
    expect(buildHandcraftedArtifact()).toEqual(buildHandcraftedArtifact());
  });
});

describe('graph invariants reject corruption', () => {
  const base = buildHandcraftedArtifact().graph;

  it('dangling parent', () => {
    const g = clone(base);
    const file = g.nodes.find((n) => n.kind === 'file')!;
    file.parentId = `node_${'f'.repeat(64)}`;
    expect(codes(validateGraphSnapshot(g))).toContain('PARENT');
  });

  it('duplicate node IDs', () => {
    const g = clone(base);
    g.nodes.splice(1, 0, clone(g.nodes[0]!));
    expect(codes(validateGraphSnapshot(g))).toContain('DUPLICATE_ID');
  });

  it('unsorted nodes', () => {
    const g = clone(base);
    g.nodes.reverse();
    expect(codes(validateGraphSnapshot(g))).toContain('UNSORTED');
  });

  it('non-finite metric', () => {
    const g = clone(base);
    g.metrics[0]!.codeLines = Number.NaN;
    expect(codes(validateGraphSnapshot(g))).toContain('SCHEMA');
  });

  it('unknown fields outside the extensions slot', () => {
    const g = clone(base) as unknown as Record<string, unknown>;
    g['surprise'] = true;
    expect(codes(validateGraphSnapshot(g))).toContain('SCHEMA');
  });

  it('accepts a namespaced extension', () => {
    const g = clone(base);
    g.extensions = { 'org.example.future': { anything: [1, 2] } };
    expect(validateGraphSnapshot(g).ok).toBe(true);
  });

  it('path traversal in a node path', () => {
    const g = clone(base);
    const file = g.nodes.find((n) => n.kind === 'file')!;
    if (file.kind === 'file') file.path = 'src/../../etc/passwd';
    expect(codes(validateGraphSnapshot(g))).toContain('SCHEMA');
  });

  it('resolved observation without target', () => {
    const g = clone(base);
    const o = g.importObservations.find((x) => x.status === 'resolved-internal')!;
    o.targetId = null;
    expect(codes(validateGraphSnapshot(g))).toEqual(expect.arrayContaining(['DANGLING']));
  });

  it('coverage that disagrees with the graph', () => {
    const g = clone(base);
    g.coverage.includedFiles += 1;
    g.coverage.discoveredFiles += 1;
    expect(codes(validateGraphSnapshot(g))).toContain('COVERAGE');
  });

  it('edge evidence count mismatch', () => {
    const g = clone(base);
    g.edges[0]!.observationCount = 7;
    expect(codes(validateGraphSnapshot(g))).toContain('EVIDENCE_COUNT');
  });

  it('wrong object format', () => {
    expect(codes(validateGraphSnapshot(base, { objectFormat: 'sha256' }))).toContain('OBJECT_FORMAT');
  });

  it('hotspot score without history', () => {
    const g = clone(base);
    g.metrics[0]!.hotspotScore = 50;
    expect(codes(validateGraphSnapshot(g))).toContain('METRIC_AVAILABILITY');
  });
});

describe('layout invariants reject corruption', () => {
  const base = buildHandcraftedArtifact().layout;

  it('overlapping plots', () => {
    const l = clone(base);
    const [a, b] = l.plots;
    b!.rect = { ...a!.rect };
    b!.districtId = a!.districtId;
    expect(codes(validateLayoutArtifact(l))).toContain('OVERLAP');
  });

  it('plot outside its district', () => {
    const l = clone(base);
    l.plots[0]!.rect.x = 1_000_000;
    expect(codes(validateLayoutArtifact(l))).toContain('CONTAINMENT');
  });

  it('non-integer and negative geometry', () => {
    const l = clone(base);
    l.plots[0]!.rect.width = 1.5;
    expect(codes(validateLayoutArtifact(l))).toContain('SCHEMA');
    const m = clone(base);
    m.plots[0]!.rect.depth = -100;
    expect(codes(validateLayoutArtifact(m))).toContain('SCHEMA');
  });

  it('unquantized height', () => {
    const l = clone(base);
    l.frameState[0]!.files[0]!.height = 1.23456;
    expect(codes(validateLayoutArtifact(l))).toContain('SCHEMA');
  });
});

describe('manifest invariants reject corruption', () => {
  const base = buildHandcraftedArtifact().manifest;

  it('chunk path traversal', () => {
    const m = clone(base);
    m.chunks[0]!.path = 'graphs/../../evil.json.gz';
    expect(codes(validateManifest(m))).toContain('SCHEMA');
  });

  it('foreign schema major', () => {
    const m = clone(base) as unknown as Record<string, unknown>;
    m['schemaVersion'] = 'atlas.graph/2.0.0';
    expect(codes(validateManifest(m))).toContain('SCHEMA');
  });

  it('duplicate chunks', () => {
    const m = clone(base);
    m.chunks.push(clone(m.chunks[0]!));
    expect(codes(validateManifest(m))).toContain('DUPLICATE_CHUNK');
  });

  it('source text flag', () => {
    const m = clone(base) as unknown as Record<string, unknown>;
    m['sourceTextIncluded'] = true;
    expect(codes(validateManifest(m))).toContain('SCHEMA');
  });

  it('oversized transport', () => {
    const m = clone(base);
    m.chunks[0]!.compressedBytes = 20 * 1_048_576 + 1;
    expect(codes(validateManifest(m))).toContain('SCHEMA');
  });
});
