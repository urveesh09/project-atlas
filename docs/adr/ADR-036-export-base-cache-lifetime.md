# ADR-036: Release adjacent delta-base caches after their last export use

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

## Decision

Expose explicit `forget(graph)` on the caller-owned cache, releasing both full natural
rows and decoder keys. After a delta's mandatory byte-for-byte round trip, the packer
forgets its base if that base is not HEAD. HEAD stays cached across keyframe intervals.
This does not add recomputation: each forgotten adjacent base is used exactly once.
The browser/default cache keeps its weak ownership behavior; no global strong cache
or cross-dataset retention is introduced.

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
objects and recreates equal derived rows/keys without mutating the graph. Existing
artifact/indexed/delta/history tests verify exact lossless transport and hostile input.
Initial targeted result: **94 checks across four suites**, plus strict types, pass.
The final full suite, independently repeated corpus hashes and capacity reports must
be recorded in status before claiming this correction verified for release.

A bounded parent V8 heap is a profiling condition, not proof of whole-job memory/CPU
limits. Exact reference/cgroup capacity and human/operator acceptance remain G6 gates.
