# ADR-026: Frame-delta and compact transports; capacity counted in stored bytes

Date: 2026-10-10. Status: accepted (artifact `atlas.artifact/1.3.0`). Amends ADR-018 (adds encodings) and ADR-024 (the cumulative cap now counts stored bytes).

## Problem

Twelve frames of the medium history fixture (3,252 files, about 31,000 imports, 40 mainline commits) exported as 13.6 MB compressed, against the 5 MiB medium target (plan §15.2). Two causes dominated:

- **Snapshot-scoped IDs.** Occurrence IDs embed the snapshot, so twelve nearly identical graphs share no bytes.
- **Derivable IDs in history and layout.** Lineage occurrences and layout frame state repeated random 64-hex node and parent IDs for every file in every frame: 5.3 MB of the 13.6 MB.

Separately, ADR-024's cumulative cap summed every frame's reconstructed size. Twelve medium frames exceeded 128 MiB, so the exporter dropped frames that consumers never hold in memory at once.

## Decision

All three transports are lossless. Each decoder rebuilds the exact canonical JSON whose SHA-256 the manifest records. The exporter proves every encoded chunk by decoding it and comparing bytes; a codec defect fails the export rather than shipping a lossy artifact. Decoders validate shapes, run lists and every reference before allocating, then the normal graph and bundle invariants run.

1. **`atlas.graph.delta/1`.** A historical graph is the base rows it keeps plus its own rows. Rows are matched by snapshot-independent natural keys:
   - nodes by kind and path or name;
   - observations by source, kind, offsets and specifier;
   - edges by endpoints, kind and confidence;
   - metrics by node.

   A base row is kept only when its whole natural form, with references as natural keys, is equal. A diagnostic whose ID is `diagnostic(snapshot, rule, first subject | first evidence)` is kept or added with `idFrom`, and the decoder re-derives its ID. Others (cycles, limits) carry literal IDs. Kept runs are `[start, length]` pairs over the base's canonical order.
2. **Keyframes.** Counting back from the selected frame, every third frame is encoded against the selected graph and the others against their next newer frame (`deltaBaseIndex`). A base must be a strictly newer frame of the same artifact, so chains are acyclic and at most three deltas long; the loader enforces this.
3. **`atlas.history.compact/1`.** Lineage occurrences become `[frame, path | null]`, with null meaning an unchanged path. Their node ID is the file occurrence ID of that path in that frame.
4. **`atlas.layout.compact/1`.** Frame files become runs over the lineage-sorted plot list, plus parent-container indices and heights. Node IDs come from the decoded history. A layout listing files in another order (legal in older artifacts) stays plain.
5. **Capacity.** The 128 MiB cumulative cap counts stored (wire) bytes. Each reconstructed chunk is capped individually by the schema. Consumers bound how many frames they hold decoded:
   - `verify`, `serve` and staging verification stream frames one at a time;
   - `inspect` decodes the selected frame only;
   - the viewer keeps the selected frame plus two others per realm.

   The 20 MiB compressed cap is unchanged.

`indexed` export mode remains exactly the 1.1/1.2 format: indexed graphs with plain history and layout. Readers accept 1.0, 1.1, 1.2 and 1.3.

## Evidence

On the dev.5 medium history fixture, the total is 4.70 MiB (4,924,526 bytes):

| Chunk | Size |
|---|---|
| Selected graph | 1.43 MiB |
| 11 deltas | 2.36 MiB |
| History | 0.49 MiB |
| Layout | 0.42 MiB |

See `docs/benchmarks/phase4-history.md` for the 20-run report. Hostile-input tests reject:

- deltas: runs beyond the base, overlapping or odd runs, a foreign or older base, out-of-range references, dropped rows, extra fields, tampered rows with self-consistent wire hashes;
- placement: a delta on the selected frame, deltas in pre-1.3 artifacts;
- compact chunks: forged occurrence frames and out-of-range layout runs.

A Git fixture whose import keeps its offset but changes line pins a defect the export-time proof caught: a kept edge citing a re-added observation.

## Consequences

Opening an old snapshot can decode up to three deltas (about 1.6 s each on the recorded machine). The viewer prefetches the next older snapshot when idle and keeps neighbours cached; cached changes meet the 250 ms budget. Older readers reject 1.3 artifacts as an unsupported version rather than misreading them.
