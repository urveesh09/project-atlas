import { z } from 'zod';
import { canonicalJson } from './canonical.js';
import { FileLineageSchema, HistoryArtifactSchema, type HistoryArtifact } from './history.js';
import { nodeId } from './ids.js';
import { HeightSchema, LayoutArtifactSchema, type LayoutArtifact } from './layout.js';
import { LIMITS } from './limits.js';
import { NodeIdSchema, RepoPathSchema, SnapshotIdSchema } from './primitives.js';

/**
 * Compact history and layout transports (ADR-026). Neither changes the canonical chunk:
 * they omit what is derivable and the decoder rebuilds the exact canonical JSON whose
 * SHA-256 the manifest records.
 *
 * - `atlas.history.compact/1`: a lineage occurrence is `[frame, path | null]` (null =
 *   same path as the previous occurrence, or the anchor path first). Its node ID is the
 *   file occurrence ID of that path in that frame's snapshot.
 * - `atlas.layout.compact/1`: a frame's files are runs over the (lineage-sorted) plot list
 *   plus aligned columns: the parent as an index into the frame's container list and the
 *   height. The node ID comes from the decoded history occurrence of that lineage.
 *
 * Every derived ID is cross-checked against the frame graphs by the bundle invariants.
 */
export const COMPACT_HISTORY_ENCODING = 'atlas.history.compact/1' as const;
export const COMPACT_LAYOUT_ENCODING = 'atlas.layout.compact/1' as const;

const frameIndex = z.number().int().min(0).max(LIMITS.analyzedFrames - 1);
const Runs = z.array(z.number().int().min(0).max(LIMITS.historicalUnionLineages)).max(LIMITS.historicalUnionLineages * 2);

const lineageShape = FileLineageSchema.shape;
export const CompactHistorySchema = HistoryArtifactSchema.omit({ lineages: true }).extend({
  encoding: z.literal(COMPACT_HISTORY_ENCODING),
  lineages: z
    .array(
      z.strictObject({
        id: lineageShape.id,
        anchorCommitOid: lineageShape.anchorCommitOid,
        anchorPath: lineageShape.anchorPath,
        continuity: lineageShape.continuity,
        occurrences: z.array(z.tuple([frameIndex, RepoPathSchema.nullable()])).max(LIMITS.analyzedFrames),
      }),
    )
    .max(LIMITS.historicalUnionLineages),
});
export type CompactHistory = z.infer<typeof CompactHistorySchema>;

const layoutShape = LayoutArtifactSchema.shape;
export const CompactLayoutSchema = LayoutArtifactSchema.omit({ frameState: true }).extend({
  encoding: z.literal(COMPACT_LAYOUT_ENCODING),
  frameState: z
    .array(
      z.strictObject({
        snapshotId: SnapshotIdSchema,
        containers: z.array(z.strictObject({ graphNodeId: NodeIdSchema, layoutDistrictId: layoutShape.districts.element.shape.id.nullable() })),
        plots: Runs,
        parents: z.array(z.number().int().min(0)).max(LIMITS.historicalUnionLineages),
        heights: z.array(HeightSchema).max(LIMITS.historicalUnionLineages),
      }),
    )
    .max(LIMITS.analyzedFrames),
});
export type CompactLayout = z.infer<typeof CompactLayoutSchema>;

function toRuns(indices: readonly number[]): number[] {
  const runs: number[] = [];
  for (const index of indices) {
    const last = runs.length - 2;
    if (last >= 0 && runs[last]! + runs[last + 1]! === index) runs[last + 1]!++;
    else runs.push(index, 1);
  }
  return runs;
}

function fromRuns(runs: readonly number[], length: number): number[] {
  if (runs.length % 2 !== 0) throw new TypeError('Runs must be start/length pairs');
  const out: number[] = [];
  let next = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const start = runs[i]!;
    const count = runs[i + 1]!;
    if (count < 1 || start < next || start + count > length) throw new TypeError('Runs are unordered, overlapping or out of bounds');
    for (let k = start; k < start + count; k++) out.push(k);
    next = start + count;
  }
  return out;
}

/** Caller validates the canonical history first; encoding never repairs data. */
export function encodeCompactHistory(history: HistoryArtifact): CompactHistory {
  const frameOf = new Map(history.frames.map((f, i) => [f.snapshotId, i]));
  return {
    ...history,
    encoding: COMPACT_HISTORY_ENCODING,
    lineages: history.lineages.map((l) => {
      let previous = l.anchorPath;
      return {
        id: l.id,
        anchorCommitOid: l.anchorCommitOid,
        anchorPath: l.anchorPath,
        continuity: l.continuity,
        occurrences: l.occurrences.map((o) => {
          const entry: [number, string | null] = [frameOf.get(o.snapshotId)!, o.path === previous ? null : o.path];
          previous = o.path;
          return entry;
        }),
      };
    }),
  };
}

export function decodeCompactHistory(input: unknown): HistoryArtifact {
  const { encoding: _encoding, ...wire } = CompactHistorySchema.parse(input);
  return {
    ...wire,
    lineages: wire.lineages.map((l) => {
      let previous = l.anchorPath;
      return {
        ...l,
        occurrences: l.occurrences.map(([frame, path]) => {
          const snapshot = wire.frames[frame]?.snapshotId;
          if (snapshot === undefined) throw new TypeError('Lineage occurrence names an unknown frame');
          previous = path ?? previous;
          return { snapshotId: snapshot, nodeId: nodeId(snapshot, 'file', previous), path: previous };
        }),
      };
    }),
  };
}

/**
 * Columns follow plot (lineage) order, which is how ATLAS writes frame files. A layout
 * whose frames list files in another valid order is not compacted (null): the plain chunk
 * keeps its exact canonical bytes.
 */
export function encodeCompactLayout(layout: LayoutArtifact): CompactLayout | null {
  const plotIndex = new Map(layout.plots.map((p, i) => [p.lineageId, i]));
  for (const frame of layout.frameState)
    for (let k = 1; k < frame.files.length; k++) if (plotIndex.get(frame.files[k - 1]!.lineageId)! >= plotIndex.get(frame.files[k]!.lineageId)!) return null;
  return {
    ...layout,
    encoding: COMPACT_LAYOUT_ENCODING,
    frameState: layout.frameState.map((frame) => {
      const containerIndex = new Map(frame.containers.map((c, i) => [c.graphNodeId, i]));
      const files = frame.files;
      return {
        snapshotId: frame.snapshotId,
        containers: frame.containers,
        plots: toRuns(files.map((f) => plotIndex.get(f.lineageId)!)),
        parents: files.map((f) => containerIndex.get(f.currentParentId)!),
        heights: files.map((f) => f.height),
      };
    }),
  };
}

export function decodeCompactLayout(input: unknown, history: HistoryArtifact): LayoutArtifact {
  const { encoding: _encoding, ...wire } = CompactLayoutSchema.parse(input);
  const occurrence = new Map<string, string>();
  for (const l of history.lineages) for (const o of l.occurrences) occurrence.set(`${o.snapshotId}|${l.id}`, o.nodeId);
  return {
    ...wire,
    frameState: wire.frameState.map((frame) => {
      const plots = fromRuns(frame.plots, wire.plots.length);
      if (plots.length !== frame.parents.length || plots.length !== frame.heights.length) throw new TypeError('Frame columns disagree in length');
      const files = plots.map((p, k) => {
        const lineageId = wire.plots[p]!.lineageId;
        const node = occurrence.get(`${frame.snapshotId}|${lineageId}`);
        const parent = frame.containers[frame.parents[k]!];
        if (node === undefined || parent === undefined) throw new TypeError('Frame file has no occurrence or parent');
        return { nodeId: node, lineageId, currentParentId: parent.graphNodeId, height: frame.heights[k]!, present: true as const };
      });
      return { snapshotId: frame.snapshotId, containers: frame.containers, files };
    }),
  };
}

/** Prove a compact pair reproduces the canonical chunks exactly (used at export). */
export function verifyCompactRoundTrip(history: HistoryArtifact, layout: LayoutArtifact, wire: { history: CompactHistory; layout: CompactLayout | null }): boolean {
  const h = decodeCompactHistory(JSON.parse(canonicalJson(wire.history)));
  if (canonicalJson(h) !== canonicalJson(history)) return false;
  return wire.layout === null || canonicalJson(decodeCompactLayout(JSON.parse(canonicalJson(wire.layout)), h)) === canonicalJson(layout);
}
