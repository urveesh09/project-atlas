# ADR-036: Bound derived export lifetimes and stream canonical graph text

Date: 2026-10-11. Status: accepted implementation correction; capacity verification pending.

## Evidence and cause

The [large-history diagnostic](../benchmarks/phase6-large-history-precache.md) observed
a 260.41 s warm-up and 3,475.10 MiB parent working set. It is not a p95 result, but
memory exceeded the 2 GiB whole-job target even before parser children were counted.

`packArtifact` kept a GraphNaturalsCache for the whole export. Its WeakMap did not make
derived row strings collectible while the caller retained all input graphs. Adjacent
historical bases have a single use in the oldest-to-newest packing order; only HEAD is
reused at keyframe intervals. Derived strings for completed adjacent bases accumulated
without contributing to subsequent packing work.

Eviction alone still failed under the production parent heap, as did flat digest
conversion alone. The [private aggregate profile](../benchmarks/phase6-large-history-heap-profile.md)
shows a 199.60 MiB canonical graph string overlapping the export's working data.
The exporter then creates another document-sized string to prove the round trip.
The cache issue and this avoidable overlap are distinct costs; no single change is
claimed sufficient before complete capacity verification.

## Decision

Match one base table at a time against one target natural row at a time. The map holds
exact canonical forms for only that table; target forms are not retained. Keep only
node/observation keys and diagnostic derivation recipes across tables/frames. HEAD
forms are recomputed at its keyframe uses rather than retained alongside other bases.
This trades some bounded recomputation for predictable peak memory; no digest-based
approximation replaces natural-form equality. Build indexed working rows after matching
ends, using a deferred encoder factory; eager indexed callers remain supported.

Expose explicit `forget(graph)` on the caller-owned cache, releasing derived data after
the mandatory byte-for-byte round trip for a single-use adjacent base. HEAD's small
key projection stays cached across keyframe intervals. The legacy explicit full-cache
API is preserved for callers, but export never materializes or retains those full forms.
The browser/default cache keeps its weak ownership behavior; no global strong cache
or cross-dataset retention is introduced.

Hash canonical graph text in 64 KiB chunks, and compare the original/reconstructed
canonical text chunks **exactly**, rather than replacing equality with a hash check.
Canonical root collection rows use the existing scalar/subtree writer. Temporary
string memory is bounded by the largest nested row, instead of joining a graph into
one document string. Chunk boundaries preserve UTF-16 surrogate pairs before UTF-8
encoding. Compression still receives the same complete canonical UTF-8 byte array.
Validator deep copies and indexed working graphs end their scope before decoding.
Digest hex conversion joins bounded byte pairs instead of building a chain of strings.

Canonical graphs, identity inputs, natural matching rules, hashes, encoded rows and
all graph/core/cross-frame validation are unchanged. No format/analyzer identity bump
is needed for a cache-lifetime correction; unchanged golden bytes and corpus comparison
remain requirements. No lossy encoding or frame dropping is used to meet the budget.

The cold historical benchmark drops the previous result before starting its next
iteration. Holding two whole datasets concurrently was a measurement artifact;
production analysis sandboxes own one dataset. Original reports are retained.
Every measured run now records complete status and twelve frames: partial runs cannot
pass simply by doing less work. The large tier uses the plan's unchanged 240 s/20 MiB
targets; the medium tier keeps 90 s/5 MiB. CLI flags/actual hardware are recorded.

## Verification and limits

The regression retains the graph while proving that forgetting releases both cache
objects, optionally preserves decoding keys while discarding forms, and recreates equal
derived rows/keys without mutating the graph. Existing
artifact/indexed/delta/history tests verify exact lossless transport and hostile input.
Initial targeted result: **94 checks across four suites**, plus strict types, pass.
After chunked canonical export, **111 checks across five suites** and strict types pass.
Independent Node SHA-256, multibyte chunk-boundary cases, invalid values/ancestor cycles,
canonical equality with reordered keys and a late-row mismatch are covered. A prior full
run overlapped a build change and saw mixed module versions; it is not final-build
evidence and is rerun after freezing the build.
The frozen chunked-export build subsequently passes **679 checks across forty suites,
none skipped**, with real hosted/storage/container/network gates enabled. Its later
table-at-a-time encoder passes the **111 targeted checks** and strict types; final-build
full verification and complete capacity measurements are still required.

`bench-history.mjs --fixture` uses prepared trusted synthetic Git objects read-only;
the caller retains ownership and the benchmark never removes that fixture. Its
production-runtime mode resolves the sandbox's installed locked packages. Resource
acceptance mode reads cgroup v2 limits and fails unless they enforce exactly four CPUs
and 2 GiB total memory, with a separate 1536 MiB parent heap. Image/source identities
and limits accompany reports. `--diagnostic-once` produces no p95 acceptance report.
The final full suite, independently repeated corpus hashes and capacity reports must
be recorded in status before claiming this correction verified for release.

A bounded parent V8 heap is a profiling condition, not proof of whole-job memory/CPU
limits. Exact reference/cgroup capacity and human/operator acceptance remain G6 gates.
