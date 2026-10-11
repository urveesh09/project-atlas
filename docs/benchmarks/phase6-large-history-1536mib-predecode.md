# Large-history diagnostic: early base-form eviction is insufficient

Recorded 2026-10-11. The near-limit synthetic history has 9,992 HEAD files, forty
commits and twelve requested frames. The parent uses the production setting
`--max-old-space-size=1536`. This attempt moved single-use delta-base form eviction
before decoding, retaining only decoder keys until the exact round trip completed.

The warm-up reached all eleven historical frames, layout and assembly, then failed
with `Allocation failed - JavaScript heap out of memory`. V8's final collection
retained approximately **1,491.1 MiB**. Process startup to failure was approximately
185.9 s, including fixture creation; this is not an analysis timing or a p95 sample.
No complete artifact or measured sample was produced.

A subsequent private near-heap-limit profile also failed. Its profiling flag changes
heap behavior and its timing is excluded from capacity acceptance. Raw profile data
stays in ignored local storage; only aggregate findings belong in release evidence.

This rules out cache lifetime as the sole cause. The digest implementation on the
actual Node build lacks native byte-to-hex support and repeatedly concatenates byte
pairs. The next diagnostic replaces this with a bounded join, retaining the same
SHA-256 bytes. Independent hash vectors, identity goldens and full canonical/wire
corpus baselines must pass before accepting that optimization.

Earlier [post-decode](phase6-large-history-1536mib-postdecode.md) and
[uncapped](phase6-large-history-precache.md) results remain recorded. No heap, timing
or artifact-size requirement has been raised; G6 capacity acceptance remains open.
