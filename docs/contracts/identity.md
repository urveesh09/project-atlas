# Identity derivations (atlas.graph/1)

Implemented in `packages/schema/src/ids.ts`, following plan §7.1. Every ID is `<prefix>_<64 lowercase hex>`, hashed from a domain tag plus length-framed fields:

```text
sha256( "d" len ":" "atlas.id/1:<prefix>"  ( tag len ":" bytes )* )
tag: s = UTF-8 string, n = decimal safe integer, z = null
```

Framing makes `["ab","c"]` and `["a","bc"]` hash differently, and `1` differ from `"1"`. A golden value in `packages/schema/test/canonical.test.ts` was checked independently with Node's `crypto`.

| ID | Prefix | Fields |
|---|---|---|
| Hosted repository | `repo` | `github.com`, numeric repository ID |
| Local repository | `repo` | `local`, persisted UUID |
| Snapshot | `snap` | repoId, commit OID, analyzer version, options digest |
| Node occurrence | `node` | snapshotId, kind, canonical path or perimeter name |
| File lineage | `lin` | repoId, history boundary commit, anchor commit, original path |
| Import observation | `obs` | snapshotId, source node, kind, start offset, end offset, specifier |
| Aggregate edge | `edge` | snapshotId, source, target, kind, confidence |
| Layout district | `dist` | repoId, anchor kind (`repository`/`package`/`directory`/`direct`), anchor path |
| Layout | `layout` | repoId, frame key, layout version, plot count |
| Analysis key | `akey` | repo identity, commit, normalized options, versions, history boundary |
| Analysis | `analysis` | 32 random bytes (not reproducible by design) |

Canonical JSON (`canonicalJson`) sorts object keys by UTF-16 code unit, uses ECMAScript number formatting and rejects non-finite numbers, `undefined`, non-plain objects and ill-formed Unicode. Repository paths are ordered by UTF-8 bytes (`compareUtf8`), never by locale.

Artifact 1.1 may store graph references as bounded array indices and omit exactly derivable IDs ([ADR-018](../adr/ADR-018-indexed-graph-transport.md)). This is transport encoding only: decoded graphs use the same full IDs and canonical hash as above. `sha256` verifies decoded canonical content; `encodedSha256` verifies wire JSON; `decodedBytes` bounds expansion before IDs are reconstructed. Plain artifact 1.0 remains readable. No cross-artifact identity or historical continuity guarantee changes.

Phase 3 preserves the graph/history golden identities. [ADR-022](../adr/ADR-022-canonical-validation-performance.md) changes allocation and hashing work, not bytes or derivations; independent Node crypto and Unicode serialization references verify equivalence. Loader-derived indexed IDs are verified during reconstruction; plain graphs still re-derive all IDs during validation. Both paths validate complete cross-chunk semantics.

Layout **1.1.0** places external anchors on integer perimeter slots inside the root bounds ([ADR-021](../adr/ADR-021-bounded-external-ring.md)). File plots, heights, lineage and district identities remain unchanged. The versioned layout ID and layout content hash change; both 1.0.0 and 1.1.0 layouts remain readable. Package facade colors use stable layout district identity rather than a snapshot node ID.

Artifact **1.2** retains indexed encoding and raises cumulative decoded capacity to **128 MiB** ([ADR-024](../adr/ADR-024-decoded-artifact-capacity.md)); compressed capacity stays 20 MiB. Readers accept 1.0/1.1/1.2. Older readers can reject 1.2 or larger exports and are not promised upgraded capacity. Decoded graph identity, source exclusion and all other ingestion limits remain unchanged.

Phase 4 uses analyzer **0.1.0-dev.5**: the bounded first-parent window defines lineage boundaries, every included change contributes continuity even between sampled frames, and additions/delete-recreates receive distinct anchors. Snapshot, graph and layout hashes change with the versioned derivations. Git renames are conservative; ambiguous identical-blob candidates split into delete/add rather than claiming continuity. A historical frame exceeding capacity is unavailable, never an incomplete city claiming the full snapshot.

Artifact **1.3** adds frame deltas and compact history/layout ([ADR-026](../adr/ADR-026-frame-delta-and-compact-transports.md)). Decoding reconstructs exact canonical IDs/bytes and verifies both wire and decoded hashes; references/runs/base order and at most three delta links are validated. The cumulative 128 MiB cap counts stored JSON, each decoded chunk retains its cap, and the selected frame plus bounded historical caches replace eager all-frame retention. Readers accept 1.0–1.3. Older consumers reject 1.3 rather than guessing new encodings.
