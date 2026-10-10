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
