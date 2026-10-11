import { z } from 'zod';
import { canonicalJson, canonicalValueEqual, compareAscii } from './canonical.js';
import { SnapshotCoverageSchema } from './coverage.js';
import type { GraphNode, GraphSnapshot, NodeMetrics } from './graph.js';
import { GraphSnapshotSchema } from './graph.js';
import { edgeId, makeId, nodeId, observationId } from './ids.js';
import { IndexedGraphSchema } from './indexed-graph.js';
import { LIMITS } from './limits.js';
import { DiagnosticIdSchema, SnapshotIdSchema } from './primitives.js';

/**
 * Frame-delta graph transport, `atlas.graph.delta/1` (ADR-026). A historical frame is
 * stored as the rows it shares with the selected (HEAD) graph plus its own rows, so twelve
 * frames of a slowly changing repository cost little more than one.
 *
 * Occurrence IDs embed the snapshot ID, so rows are matched on snapshot-independent
 * natural keys: a node by kind and canonical path/name, an observation by source, kind,
 * range and specifier, an edge by endpoints, kind and confidence, a metric by node. A base
 * row is kept only when its whole natural form, with references expressed as natural
 * keys, equals the frame's row. The decoder re-derives every ID for the frame's snapshot,
 * restores canonical order and yields the canonical graph whose SHA-256 the manifest
 * records; nothing is approximated. Diagnostics with a derivable subject/evidence identity
 * can be kept with an identity recipe; diagnostics using another identity carry literal IDs.
 */
export const DELTA_GRAPH_ENCODING = 'atlas.graph.delta/1' as const;

const wireRows = IndexedGraphSchema.shape;
/** Kept base rows as flat `[start, length, start, length, ...]` runs in base canonical order. */
const RunsSchema = z.array(z.number().int().min(0).max(LIMITS.dependencyEvidenceRowsPerSnapshot)).max(LIMITS.dependencyEvidenceRowsPerSnapshot * 2);

export const DeltaGraphSchema = z.strictObject({
  encoding: z.literal(DELTA_GRAPH_ENCODING),
  baseSnapshotId: SnapshotIdSchema,
  snapshotId: GraphSnapshotSchema.shape.snapshotId,
  repoId: GraphSnapshotSchema.shape.repoId,
  commitOid: GraphSnapshotSchema.shape.commitOid,
  coverage: SnapshotCoverageSchema,
  extensions: GraphSnapshotSchema.shape.extensions,
  nodes: z.strictObject({ keep: RunsSchema, add: wireRows.nodes }),
  importObservations: z.strictObject({ keep: RunsSchema, add: wireRows.importObservations }),
  edges: z.strictObject({ keep: RunsSchema, add: wireRows.edges }),
  metrics: z.strictObject({ keep: RunsSchema, add: wireRows.metrics }),
  /**
   * Diagnostic IDs embed the snapshot. Most are `diagnostic(snapshot, rule, X)` with X the
   * first subject or first evidence occurrence: `idFrom` names which, and the decoder
   * re-derives the ID. Others (cycles, limits) carry their literal ID.
   */
  diagnostics: z.strictObject({
    keep: RunsSchema,
    add: z
      .array(
        wireRows.diagnostics.element
          .omit({ id: true })
          .extend({ id: DiagnosticIdSchema.optional(), idFrom: z.enum(['subject', 'evidence']).nullable() })
          .refine((d) => (d.idFrom === null) === (d.id !== undefined), 'A literal ID is present exactly when it is not derivable'),
      )
      .max(LIMITS.diagnosticsPerFrame),
  }),
});
export type DeltaGraph = z.infer<typeof DeltaGraphSchema>;

// ---------------------------------------------------------------------------------------
// Natural keys and forms
// ---------------------------------------------------------------------------------------

function nodeKey(node: GraphNode): string {
  switch (node.kind) {
    case 'repository':
      return 'repository\u0000';
    case 'builtin':
      return `builtin\u0000${node.moduleName}`;
    case 'external-package':
      return `external-package\u0000${node.packageName}`;
    default:
      return `${node.kind}\u0000${node.path}`;
  }
}

/** Node identity inputs from a natural key (the inverse of `nodeKey`). */
function nodeIdFromKey(snapshot: string, key: string): string {
  const split = key.indexOf('\u0000');
  const kind = key.slice(0, split) as GraphNode['kind'];
  return nodeId(snapshot, kind, kind === 'repository' ? '' : key.slice(split + 1));
}

interface Natural {
  /** Snapshot-independent identity of the row within its table. */
  key: string;
  /** Canonical JSON of the whole row with references as natural keys. */
  form: string;
}

type IdFrom = 'subject' | 'evidence' | null;

interface GraphNaturals {
  nodeKeys: string[];
  observationKeys: string[];
  nodes: Natural[];
  observations: Natural[];
  edges: Natural[];
  metrics: Natural[];
  diagnostics: (Natural & { idFrom: IdFrom })[];
}

/** How a diagnostic's ID derives from its own fields, if it does. */
function diagnosticIdFrom(snapshot: string, d: { id: string; ruleId: string; subjectIds: readonly string[]; evidenceIds: readonly string[] }): IdFrom {
  if (d.subjectIds[0] !== undefined && makeId('diagnostic', [snapshot, d.ruleId, d.subjectIds[0]]) === d.id) return 'subject';
  if (d.evidenceIds[0] !== undefined && makeId('diagnostic', [snapshot, d.ruleId, d.evidenceIds[0]]) === d.id) return 'evidence';
  return null;
}

function* naturalMap<Row, N extends Natural>(rows: readonly Row[], make: (row: Row, index: number) => N): Generator<N> {
  for (let i = 0; i < rows.length; i++) yield make(rows[i]!, i);
}

/** Keys live across tables; full forms are generated only for the active table/row. */
function naturalRows(graph: GraphSnapshot, keys = baseKeys(graph)) {
  const nodeKeyById = new Map(graph.nodes.map((n, i) => [n.id, keys.nodeKeys[i]!]));
  const nk = (id: string | null): string | null => {
    if (id === null) return null;
    const key = nodeKeyById.get(id);
    if (key === undefined) throw new TypeError('Graph reference is dangling');
    return key;
  };
  const nodes = () => naturalMap(graph.nodes, (n): Natural => {
    const { id: _id, parentId, ...rest } = n;
    const form = rest.kind === 'external-package' ? { ...rest, declaredRanges: rest.declaredRanges.map((r) => ({ ...r, packageNodeId: nk(r.packageNodeId) })) } : rest;
    return { key: nodeKeyById.get(n.id)!, form: canonicalJson({ ...form, parentId: nk(parentId) }) };
  });
  const observationKeyById = new Map(graph.importObservations.map((o, i) => [o.id, keys.observationKeys[i]!]));
  const observations = () => naturalMap(graph.importObservations, (o, i): Natural => {
    const { id: _id, sourceId, targetId, ...rest } = o;
    const key = keys.observationKeys[i]!;
    return { key, form: canonicalJson({ ...rest, sourceId: nk(sourceId), targetId: nk(targetId) }) };
  });
  const ok = (id: string): string => {
    const key = observationKeyById.get(id);
    if (key === undefined) throw new TypeError('Graph evidence reference is dangling');
    return key;
  };
  const edges = () => naturalMap(graph.edges, (e): Natural => {
    const { id: _id, sourceId, targetId, evidenceIds, ...rest } = e;
    return {
      key: canonicalJson([nk(sourceId), nk(targetId), e.kind, e.confidence]),
      form: canonicalJson({ ...rest, sourceId: nk(sourceId), targetId: nk(targetId), evidenceIds: evidenceIds.map(ok) }),
    };
  });
  const metrics = () => naturalMap(graph.metrics, (m): Natural => {
    const { nodeId: id, ...rest } = m;
    return { key: nk(id)!, form: canonicalJson({ ...rest, nodeId: nk(id) }) };
  });
  // Diagnostics are keyed by their whole natural form (plus an ordinal among identical
  // forms); only derivable ones can ever be kept.
  const diagnostics = () => {
    const seen = new Map<string, number>();
    return naturalMap(graph.diagnostics, (d, i) => {
      const { id: _id, subjectIds, evidenceIds, ...rest } = d;
      const idFrom = keys.diagnosticIdFrom[i]!;
      const form = canonicalJson({ ...rest, subjectIds: subjectIds.map((s) => nk(s)), evidenceIds: evidenceIds.map(ok), idFrom });
      const ordinal = seen.get(form) ?? 0;
      seen.set(form, ordinal + 1);
      return { key: idFrom === null ? `literal:${d.id}` : `${form}#${ordinal}`, form, idFrom };
    });
  };
  return { ...keys, nodes, observations, edges, metrics, diagnostics };
}

/** Optional full materialization for callers explicitly requesting the legacy cache. */
function naturals(graph: GraphSnapshot): GraphNaturals {
  const rows = naturalRows(graph);
  return {
    nodeKeys: rows.nodeKeys, observationKeys: rows.observationKeys,
    nodes: [...rows.nodes()], observations: [...rows.observations()], edges: [...rows.edges()],
    metrics: [...rows.metrics()], diagnostics: [...rows.diagnostics()],
  };
}

// ---------------------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------------------

function toRuns(indices: readonly number[]): number[] {
  const runs: number[] = [];
  for (const index of indices) {
    const last = runs.length - 2;
    if (last >= 0 && runs[last]! + runs[last + 1]! === index) runs[last + 1]!++;
    else runs.push(index, 1);
  }
  return runs;
}

/** Rows of `target` equal to a `base` row are kept by base position; the rest are added. */
function split(base: Iterable<Natural>, target: Iterable<Natural>): { keep: number[]; added: number[] } {
  const baseByKey = new Map<string, { index: number; form: string }>();
  let position = 0;
  for (const row of base) baseByKey.set(row.key, { index: position++, form: row.form });
  const kept: number[] = [];
  const added: number[] = [];
  position = 0;
  for (const row of target) {
    const b = baseByKey.get(row.key);
    if (b !== undefined && b.form === row.form) kept.push(b.index);
    else added.push(position);
    position++;
  }
  kept.sort((x, y) => x - y);
  return { keep: toRuns(kept), added };
}

/** Natural form of a row's reference fields; the snapshot-specific `id` is omitted. */
type NaturalRefs<Row> = { readonly [field: string]: (row: Row) => unknown };

/**
 * `canonicalValueEqual` of two rows' natural forms (see `naturalRows`): every field except
 * `id` compared directly, reference fields compared through their natural keys.
 */
function sameNaturalForm<Row extends object>(b: Row, bRefs: NaturalRefs<Row>, t: Row, tRefs: NaturalRefs<Row>): boolean {
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(t).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(t, key)) return false;
    if (key === 'id') continue;
    const bRef = bRefs[key];
    const same = bRef ? canonicalValueEqual(bRef(b), tRefs[key]!(t)) : canonicalValueEqual((b as Record<string, unknown>)[key], (t as Record<string, unknown>)[key]);
    if (!same) return false;
  }
  return true;
}

interface MatchTable<Row> {
  rows: readonly Row[];
  key: (row: Row, index: number) => string;
  refs: NaturalRefs<Row>;
}

/**
 * The same decision as `split` over natural forms, without materializing a canonical
 * form string per row of both graphs: a target row is kept when a base row has its
 * natural key and an equal natural form.
 */
function splitTable<Row extends object>(base: MatchTable<Row>, target: MatchTable<Row>): { keep: number[]; added: number[] } {
  const baseByKey = new Map<string, number>();
  for (let i = 0; i < base.rows.length; i++) baseByKey.set(base.key(base.rows[i]!, i), i);
  const kept: number[] = [];
  const added: number[] = [];
  for (let i = 0; i < target.rows.length; i++) {
    const row = target.rows[i]!;
    const index = baseByKey.get(target.key(row, i));
    if (index !== undefined && sameNaturalForm(base.rows[index]!, base.refs, row, target.refs)) kept.push(index);
    else added.push(i);
  }
  kept.sort((x, y) => x - y);
  return { keep: toRuns(kept), added };
}

/** Match tables for nodes, observations, edges and metrics; mirrors `naturalRows`. */
function matchTables(graph: GraphSnapshot, keys: BaseKeys) {
  const nodeKeyById = new Map(graph.nodes.map((n, i) => [n.id, keys.nodeKeys[i]!]));
  const nk = (id: string | null): string | null => {
    if (id === null) return null;
    const key = nodeKeyById.get(id);
    if (key === undefined) throw new TypeError('Graph reference is dangling');
    return key;
  };
  const observationKeyById = new Map(graph.importObservations.map((o, i) => [o.id, keys.observationKeys[i]!]));
  const ok = (id: string): string => {
    const key = observationKeyById.get(id);
    if (key === undefined) throw new TypeError('Graph evidence reference is dangling');
    return key;
  };
  const nodes: MatchTable<GraphNode> = {
    rows: graph.nodes,
    key: (_n, i) => keys.nodeKeys[i]!,
    refs: {
      parentId: (n) => nk(n.parentId),
      declaredRanges: (n) => (n.kind === 'external-package' ? n.declaredRanges.map((r) => ({ ...r, packageNodeId: nk(r.packageNodeId) })) : (n as { declaredRanges?: unknown }).declaredRanges),
    },
  };
  type Observation = GraphSnapshot['importObservations'][number];
  const observations: MatchTable<Observation> = {
    rows: graph.importObservations,
    key: (_o, i) => keys.observationKeys[i]!,
    refs: { sourceId: (o) => nk(o.sourceId), targetId: (o) => nk(o.targetId) },
  };
  type Edge = GraphSnapshot['edges'][number];
  const edges: MatchTable<Edge> = {
    rows: graph.edges,
    // An internal matching key only: any injective encoding works, and JSON.stringify of
    // these well-formed strings equals their canonical JSON.
    key: (e) => JSON.stringify([nk(e.sourceId), nk(e.targetId), e.kind, e.confidence]),
    refs: { sourceId: (e) => nk(e.sourceId), targetId: (e) => nk(e.targetId), evidenceIds: (e) => e.evidenceIds.map(ok) },
  };
  type Metric = GraphSnapshot['metrics'][number];
  const metrics: MatchTable<Metric> = {
    rows: graph.metrics,
    key: (m) => nk(m.nodeId)!,
    refs: { nodeId: (m) => nk(m.nodeId) },
  };
  return { nodes, observations, edges, metrics };
}

/**
 * Encode a validated canonical frame graph against the validated canonical base graph.
 * Added rows use the indexed wire shape with references as positions in the frame's own
 * canonical arrays, exactly like `atlas.graph.indexed/1`.
 */
export function encodeDeltaGraph(graph: GraphSnapshot, base: GraphSnapshot, indexedInput: z.infer<typeof IndexedGraphSchema> | (() => z.infer<typeof IndexedGraphSchema>), baseNaturals?: GraphNaturalsCache): DeltaGraph {
  const baseKeysValue = baseNaturals?.keys(base) ?? baseKeys(base);
  const b = naturalRows(base, baseKeysValue);
  const t = naturalRows(graph);
  // Row tables compare natural forms structurally; only diagnostics, whose keys are
  // their forms, still build canonical form text.
  const bm = matchTables(base, baseKeysValue);
  const tm = matchTables(graph, t);
  const nodes = splitTable(bm.nodes, tm.nodes);
  const observations = splitTable(bm.observations, tm.observations);
  const edges = splitTable(bm.edges, tm.edges);
  const metrics = splitTable(bm.metrics, tm.metrics);
  // A literal (non-derivable) ID is snapshot-specific, so such a diagnostic is never kept.
  function* keepableDiagnostics() {
    for (const d of b.diagnostics()) yield d.idFrom === null ? { ...d, key: `base:${d.key}` } : d;
  }
  const diagnostics = split(keepableDiagnostics(), t.diagnostics());
  // Do not overlap all indexed rows with matching's base forms. Existing callers
  // can still provide an eager indexed graph; the exporter provides this factory.
  const indexed = typeof indexedInput === 'function' ? indexedInput() : indexedInput;
  return {
    encoding: DELTA_GRAPH_ENCODING,
    baseSnapshotId: base.snapshotId,
    snapshotId: graph.snapshotId,
    repoId: graph.repoId,
    commitOid: graph.commitOid,
    coverage: graph.coverage,
    ...(graph.extensions !== undefined ? { extensions: graph.extensions } : {}),
    nodes: { keep: nodes.keep, add: nodes.added.map((i) => indexed.nodes[i]!) },
    importObservations: { keep: observations.keep, add: observations.added.map((i) => indexed.importObservations[i]!) },
    edges: { keep: edges.keep, add: edges.added.map((i) => indexed.edges[i]!) },
    metrics: { keep: metrics.keep, add: metrics.added.map((i) => indexed.metrics[i]!) },
    diagnostics: {
      keep: diagnostics.keep,
      add: diagnostics.added.map((i) => {
        const { id, ...row } = indexed.diagnostics[i]!;
        const idFrom = t.diagnosticIdFrom[i]!;
        return idFrom === null ? { ...row, id, idFrom } : { ...row, idFrom };
      }),
    },
  };
}

/** Reuse the base graph's natural forms across many frames. */
/** What decoding needs from a base: row keys and diagnostic ID derivation, no forms. */
interface BaseKeys {
  nodeKeys: string[];
  observationKeys: string[];
  diagnosticIdFrom: IdFrom[];
}

function baseKeys(graph: GraphSnapshot): BaseKeys {
  const nodeKeyById = new Map(graph.nodes.map((n) => [n.id, nodeKey(n)]));
  return {
    nodeKeys: graph.nodes.map((n) => nodeKeyById.get(n.id)!),
    observationKeys: graph.importObservations.map((o) => canonicalJson([nodeKeyById.get(o.sourceId)!, o.kind, o.range.startOffset, o.range.endOffset, o.specifier])),
    diagnosticIdFrom: graph.diagnostics.map((d) => diagnosticIdFrom(graph.snapshotId, d)),
  };
}

export class GraphNaturalsCache {
  private readonly cache = new WeakMap<GraphSnapshot, GraphNaturals>();
  private readonly keyCache = new WeakMap<GraphSnapshot, BaseKeys>();
  /** Release derived rows after a caller's last use of a still-retained graph. */
  forget(graph: GraphSnapshot, options: { keepDecodingKeys?: boolean } = {}): void {
    if (options.keepDecodingKeys) this.keys(graph);
    this.cache.delete(graph);
    if (!options.keepDecodingKeys) this.keyCache.delete(graph);
  }
  /** Keys only (cheap): enough to decode a delta against `graph`. */
  keys(graph: GraphSnapshot): BaseKeys {
    let value = this.keyCache.get(graph);
    if (!value) {
      const full = this.cache.get(graph);
      value = full ? { nodeKeys: full.nodeKeys, observationKeys: full.observationKeys, diagnosticIdFrom: full.diagnostics.map((d) => d.idFrom) } : baseKeys(graph);
      this.keyCache.set(graph, value);
    }
    return value;
  }
  get(graph: GraphSnapshot): GraphNaturals {
    let value = this.cache.get(graph);
    if (!value) {
      value = naturals(graph);
      this.cache.set(graph, value);
    }
    return value;
  }
}

// ---------------------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------------------

function expandRuns(runs: readonly number[], length: number): number[] {
  if (runs.length % 2 !== 0) throw new TypeError('Delta runs must be start/length pairs');
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const start = runs[i]!;
    const count = runs[i + 1]!;
    if (count < 1 || start < next || start + count > length) throw new TypeError('Delta runs are unordered, overlapping or out of bounds');
    for (let k = start; k < start + count; k++) out.push(k);
    next = start + count;
  }
  return out;
}

/**
 * Rebuild the canonical frame graph. `base` must be the validated decoded base graph named
 * by `baseSnapshotId`. Shapes, runs and every reference are checked before use; the caller
 * still verifies the decoded length/hash and runs the full graph invariants.
 */
export function decodeDeltaGraph(input: unknown, base: GraphSnapshot, baseNaturals?: GraphNaturalsCache): GraphSnapshot {
  const wire = DeltaGraphSchema.parse(input);
  if (wire.baseSnapshotId !== base.snapshotId) throw new TypeError('Delta graph names a different base');
  if (wire.repoId !== base.repoId) throw new TypeError('Delta graph belongs to a different repository');
  if (wire.extensions !== undefined) canonicalJson(wire.extensions);
  const b = baseNaturals?.keys(base) ?? baseKeys(base);
  const snap = wire.snapshotId;

  // 1. Node order: derive every frame node ID, then sort canonically.
  const keptNodes = expandRuns(wire.nodes.keep, base.nodes.length);
  const nodeCount = keptNodes.length + wire.nodes.add.length;
  if (nodeCount > LIMITS.treeEntriesPerSnapshot) throw new RangeError('Delta graph exceeds the node limit');
  const addedNodeKey = (n: (typeof wire.nodes.add)[number]) =>
    n.kind === 'repository' ? 'repository\u0000' : n.kind === 'builtin' ? `builtin\u0000${n.moduleName}` : n.kind === 'external-package' ? `external-package\u0000${n.packageName}` : `${n.kind}\u0000${n.path}`;
  const nodeKeys = [...keptNodes.map((i) => b.nodeKeys[i]!), ...wire.nodes.add.map(addedNodeKey)];
  const nodeIds = nodeKeys.map((key) => nodeIdFromKey(snap, key));
  const nodeOrder = nodeIds.map((id, i) => [id, i] as const).sort((x, y) => compareAscii(x[0], y[0]));
  const positionOfKey = new Map<string, number>();
  nodeOrder.forEach(([, original], position) => {
    if (positionOfKey.has(nodeKeys[original]!)) throw new TypeError('Delta graph repeats a node');
    positionOfKey.set(nodeKeys[original]!, position);
  });
  const sortedNodeIds = nodeOrder.map(([id]) => id);
  const sortedNodeKeys = nodeOrder.map(([, original]) => nodeKeys[original]!);
  const byPosition = (position: number): string => {
    const id = sortedNodeIds[position];
    if (id === undefined) throw new TypeError('Delta graph reference is out of bounds');
    return id;
  };
  const byKey = (key: string | null): string | null => {
    if (key === null) return null;
    const position = positionOfKey.get(key);
    if (position === undefined) throw new TypeError('Kept row references a node absent from the frame');
    return sortedNodeIds[position]!;
  };

  const baseNodeKeyById = new Map(base.nodes.map((n, i) => [n.id, b.nodeKeys[i]!]));
  const fromBase = (id: string | null) => byKey(id === null ? null : baseNodeKeyById.get(id)!);
  const nodeRows: GraphNode[] = new Array(nodeCount);
  keptNodes.forEach((baseIndex, i) => {
    const source = base.nodes[baseIndex]!;
    const row = { ...source, id: nodeIds[i]!, parentId: fromBase(source.parentId) } as GraphNode;
    if (row.kind === 'external-package')
      (row as { declaredRanges: unknown }).declaredRanges = row.declaredRanges.map((r) => ({ ...r, packageNodeId: fromBase(r.packageNodeId)! }));
    nodeRows[positionOfKey.get(nodeKeys[i]!)!] = row;
  });
  wire.nodes.add.forEach((n, j) => {
    const i = keptNodes.length + j;
    const row = { ...n, id: nodeIds[i]!, parentId: n.parentId === null ? null : byPosition(n.parentId) } as GraphNode;
    if (row.kind === 'external-package' && n.kind === 'external-package')
      (row as { declaredRanges: unknown }).declaredRanges = n.declaredRanges.map((r) => ({ ...r, packageNodeId: byPosition(r.packageNodeId) }));
    nodeRows[positionOfKey.get(nodeKeys[i]!)!] = row;
  });

  // 2. Observations: derive IDs from the frame's node IDs, then sort.
  const keptObservations = expandRuns(wire.importObservations.keep, base.importObservations.length);
  if (keptObservations.length + wire.importObservations.add.length > LIMITS.dependencyEvidenceRowsPerSnapshot) throw new RangeError('Delta graph exceeds the evidence limit');
  const observationRows = [
    ...keptObservations.map((i) => {
      const o = base.importObservations[i]!;
      const sourceId = fromBase(o.sourceId)!;
      return { row: { ...o, id: observationId(snap, sourceId, o.kind, o.range, o.specifier), sourceId, targetId: fromBase(o.targetId) }, key: b.observationKeys[i]! };
    }),
    ...wire.importObservations.add.map((o) => {
      const sourceId = byPosition(o.sourceId);
      const targetId = o.targetId === null ? null : byPosition(o.targetId);
      // Added rows get their natural key too: a kept edge may cite a re-added observation.
      return { row: { ...o, id: observationId(snap, sourceId, o.kind, o.range, o.specifier), sourceId, targetId }, key: canonicalJson([sortedNodeKeys[o.sourceId]!, o.kind, o.range.startOffset, o.range.endOffset, o.specifier]) };
    }),
  ].sort((x, y) => compareAscii(x.row.id, y.row.id));
  const observationIdByBaseKey = new Map<string, string>();
  for (const { row, key } of observationRows) {
    if (observationIdByBaseKey.has(key)) throw new TypeError('Delta graph repeats an observation');
    observationIdByBaseKey.set(key, row.id);
  }
  const observationIds = observationRows.map((o) => o.row.id);
  const observationAt = (position: number): string => {
    const id = observationIds[position];
    if (id === undefined) throw new TypeError('Delta graph evidence reference is out of bounds');
    return id;
  };
  const baseObservationKeyById = new Map(base.importObservations.map((o, i) => [o.id, b.observationKeys[i]!]));

  // 3. Edges.
  const keptEdges = expandRuns(wire.edges.keep, base.edges.length);
  if (keptEdges.length + wire.edges.add.length > LIMITS.sourceDependencyEdgesPerSnapshot) throw new RangeError('Delta graph exceeds the edge limit');
  const edges = [
    ...keptEdges.map((i) => {
      const e = base.edges[i]!;
      const sourceId = fromBase(e.sourceId)!;
      const targetId = fromBase(e.targetId)!;
      const evidenceIds = e.evidenceIds.map((id) => {
        const kept = observationIdByBaseKey.get(baseObservationKeyById.get(id)!);
        if (kept === undefined) throw new TypeError('Kept edge evidence is absent from the frame');
        return kept;
      });
      return { ...e, id: edgeId(snap, sourceId, targetId, e.kind, e.confidence), sourceId, targetId, evidenceIds };
    }),
    ...wire.edges.add.map((e) => {
      const sourceId = byPosition(e.sourceId);
      const targetId = byPosition(e.targetId);
      return { ...e, id: edgeId(snap, sourceId, targetId, e.kind, e.confidence), sourceId, targetId, evidenceIds: e.evidenceIds.map(observationAt) };
    }),
  ].sort((x, y) => compareAscii(x.id, y.id));

  // 4. Metrics, ordered by node ID.
  const keptMetrics = expandRuns(wire.metrics.keep, base.metrics.length);
  if (keptMetrics.length + wire.metrics.add.length > LIMITS.treeEntriesPerSnapshot) throw new RangeError('Delta graph exceeds the metric limit');
  const metrics: NodeMetrics[] = [
    ...keptMetrics.map((i) => {
      const m = base.metrics[i]!;
      return { ...m, nodeId: fromBase(m.nodeId)! };
    }),
    ...wire.metrics.add.map((m) => ({ ...m, nodeId: byPosition(m.nodeId) })),
  ].sort((x, y) => compareAscii(x.nodeId, y.nodeId));

  // 5. Diagnostics: kept rows from the base with re-derived IDs, then added rows.
  const derive = (ruleId: string, idFrom: 'subject' | 'evidence', subjects: readonly string[], evidence: readonly string[]) => {
    const x = idFrom === 'subject' ? subjects[0] : evidence[0];
    if (x === undefined) throw new TypeError('Derivable diagnostic has no identity occurrence');
    return makeId('diagnostic', [snap, ruleId, x]);
  };
  const keptDiagnostics = expandRuns(wire.diagnostics.keep, base.diagnostics.length);
  if (keptDiagnostics.length + wire.diagnostics.add.length > LIMITS.diagnosticsPerFrame) throw new RangeError('Delta graph exceeds the diagnostic limit');
  const diagnosticRows = [
    ...keptDiagnostics.map((i) => {
      const d = base.diagnostics[i]!;
      const idFrom = b.diagnosticIdFrom[i]!;
      if (idFrom === null) throw new TypeError('A literal-ID diagnostic cannot be kept');
      const subjectIds = d.subjectIds.map((id) => fromBase(id)!);
      const evidenceIds = d.evidenceIds.map((id) => {
        const kept = observationIdByBaseKey.get(baseObservationKeyById.get(id)!);
        if (kept === undefined) throw new TypeError('Kept diagnostic evidence is absent from the frame');
        return kept;
      });
      return { ...d, id: derive(d.ruleId, idFrom, subjectIds, evidenceIds), subjectIds, evidenceIds };
    }),
    ...wire.diagnostics.add.map(({ idFrom, id, ...d }) => {
      const subjectIds = d.subjectIds.map(byPosition);
      const evidenceIds = d.evidenceIds.map(observationAt);
      return { ...d, id: idFrom === null ? id! : derive(d.ruleId, idFrom, subjectIds, evidenceIds), subjectIds, evidenceIds };
    }),
  ].sort((x, y) => compareAscii(x.id, y.id));

  const graph: GraphSnapshot = {
    snapshotId: snap,
    repoId: wire.repoId,
    commitOid: wire.commitOid,
    nodes: nodeRows,
    edges,
    importObservations: observationRows.map((o) => o.row),
    diagnostics: diagnosticRows,
    metrics,
    coverage: wire.coverage,
    ...(wire.extensions !== undefined ? { extensions: wire.extensions } : {}),
  };
  return graph;
}
