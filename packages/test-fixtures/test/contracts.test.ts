import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256, validateArtifactBundle, validateGraphSnapshot, type ValidationResult } from '@atlas/schema';
import { buildHandcraftedArtifact } from '@atlas/test-fixtures';

/**
 * P1.1 evidence: cross-platform canonical hashes, an independent JSON Schema validator
 * over the generated schemas, ID re-derivation and cross-chunk bundle invariants.
 */
const artifact = buildHandcraftedArtifact();
const bundle = () => structuredClone({ manifest: artifact.manifest, graphs: [artifact.graph], history: artifact.history, layout: artifact.layout });
const codes = (r: ValidationResult<unknown>) => (r.ok ? [] : r.issues.map((i) => i.code));

describe('canonical hashes are identical on every platform', () => {
  // These goldens are asserted by CI on both Windows and Linux. A change means either
  // the canonical form or an identity derivation changed: that is a contract version bump.
  it.each([
    ['graph', () => artifact.graph, 'fd4d32df76b53752270229a5206c2a23033dec3045b17c55009236a546b05c31'],
    ['history', () => artifact.history, 'f37c5dbdba73d0d88100e21a8cd0e0079522af9124b8b48825d3a9dd6d21d468'],
    ['layout', () => artifact.layout, 'c4d475c4b9ab6999ae29ffea2887893ab344d61e99fb1ac1a9bfb3a2738b54b4'],
  ])('%s', (_name, value, expected) => {
    expect(canonicalJsonSha256(value())).toBe(expected);
  });
});

describe('generated JSON Schema agrees with the runtime schema (independent validator)', () => {
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  const compiled = new Map<string, ReturnType<typeof ajv.compile>>();
  const load = (name: string) => {
    if (!compiled.has(name)) {
      const file = fileURLToPath(new URL(`../../schema/generated/${name}.schema.json`, import.meta.url));
      compiled.set(name, ajv.compile(JSON.parse(readFileSync(file, 'utf8'))));
    }
    return compiled.get(name)!;
  };
  const cases = [
    ['graph-snapshot', () => artifact.graph],
    ['history-artifact', () => artifact.history],
    ['layout-artifact', () => artifact.layout],
    ['artifact-manifest', () => artifact.manifest],
  ] as const;

  it.each(cases)('%s accepts the handcrafted chunk', (name, value) => {
    const validate = load(name);
    expect(validate(value()), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each(cases)('%s rejects unknown properties and malformed IDs', (name, value) => {
    const validate = load(name);
    const extra = { ...structuredClone(value()), unexpected: 1 } as Record<string, unknown>;
    expect(validate(extra)).toBe(false);
    const broken = structuredClone(value()) as Record<string, unknown>;
    const idKey = Object.keys(broken).find((k) => /Id$/.test(k) && typeof broken[k] === 'string')!;
    broken[idKey] = 'not-an-id';
    expect(validate(broken)).toBe(false);
  });
});

describe('IDs must derive from their contents', () => {
  it('rejects a node whose path was edited without re-deriving its ID', () => {
    const g = structuredClone(artifact.graph);
    const file = g.nodes.find((n) => n.kind === 'file' && n.path === 'src/util.ts')!;
    if (file.kind === 'file') file.path = 'src/other.ts';
    expect(codes(validateGraphSnapshot(g))).toContain('ID_MISMATCH');
    expect(validateGraphSnapshot(g, { verifyIds: false }).ok).toBe(true);
  });

  it('rejects an edge whose kind changed', () => {
    const g = structuredClone(artifact.graph);
    const edge = g.edges.find((e) => e.kind === 'imports-type')!;
    edge.confidence = 'heuristic';
    expect(codes(validateGraphSnapshot(g))).toContain('ID_MISMATCH');
  });
});

describe('artifact bundle cross-references', () => {
  it('accepts the handcrafted bundle', () => {
    const r = validateArtifactBundle(bundle());
    expect(r.ok ? [] : r.issues).toEqual([]);
  });

  it('rejects a missing graph', () => {
    const b = bundle();
    b.graphs = [];
    expect(codes(validateArtifactBundle(b))).toContain('FRAME_COUNT');
  });

  it('rejects frame counts that disagree with the graph', () => {
    const b = bundle();
    b.manifest.frames[0]!.nodeCount += 1;
    expect(codes(validateArtifactBundle(b))).toContain('FRAME_MISMATCH');
  });

  it('rejects a file without frame state', () => {
    const b = bundle();
    b.layout.frameState[0]!.files.pop();
    expect(codes(validateArtifactBundle(b))).toContain('FRAME_STATE');
  });

  it('rejects a file missing from its lineage', () => {
    const b = bundle();
    b.history.lineages[0]!.occurrences = [];
    expect(codes(validateArtifactBundle(b))).toContain('LINEAGE');
  });

  it('rejects head coverage that differs from the selected frame', () => {
    const b = bundle();
    b.manifest.coverage.head = { ...b.manifest.coverage.head, observedImports: 99 };
    expect(codes(validateArtifactBundle(b))).toContain('COVERAGE');
  });
});
