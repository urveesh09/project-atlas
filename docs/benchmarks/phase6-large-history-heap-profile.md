# Large-history private heap profile: canonical export overlap

Recorded 2026-10-11. This diagnostic profiles the pre-streaming export with early
delta-base form eviction, twelve requested frames, 9,992 HEAD files, forty commits
and the production parent setting `--max-old-space-size=1536`. The additional
`--heapsnapshot-near-heap-limit=1` flag changes heap behavior; its timing and memory
are **not capacity acceptance measurements**. The run still ultimately failed.

The private V8 snapshot contains 20,248,531 nodes and 90,514,686 edges. Aggregate
shallow sizes (not a dominator/retained-size attribution):

| Type | Count | Shallow MiB |
|---|---:|---:|
| Flat strings | 5,278,343 | 623.06 |
| Objects | 5,912,570 | 405.99 |
| Array storage | 1,470,960 | 225.65 |
| Concatenated strings | 6,229,088 | 190.10 |

One flat string, beginning with the canonical graph's `commitOid` field, occupies
**199.60 MiB** alone. The exporter retains the entire canonical graph text while
encoding a frame, then serializes a reconstructed graph into another whole-document
string for exact comparison. This is avoidable overlap with twelve canonical graphs,
natural matching rows, indexed working rows and validation copies. The profile does
not attribute every concatenated string to hashing or prove a dominator root.

Changing hash hex conversion to a bounded join alone subsequently still failed under
the production parent heap (about 1,496.8 MiB retained after the final collection;
215.2 s from process startup including fixture generation). That diagnostic overlapped
profile summarization and is excluded from performance timing. Hash conversion alone
is not recorded as a capacity fix.

The next correction hashes canonical graph chunks without materializing its document
string, and compares the original/reconstructed **exact canonical text chunks**.
Digest equality does not replace the lossless comparison. Compression receives the
same canonical UTF-8 bytes; scalar/row serialization shares the existing canonical
writer. Validation copies and indexed encoder inputs have shorter scopes. UTF-8
encoding never splits a surrogate pair at chunk boundaries. Formats, IDs and hashes
must remain unchanged, verified against the previously committed corpus baseline.

Raw heap data and profiling tooling remain ignored locally; no source, environment
data or raw heap is committed/uploaded. Earlier failure evidence remains in the
[pre-decode diagnostic](phase6-large-history-1536mib-predecode.md). Acceptance still
requires complete measured runs under the declared resource limits.
