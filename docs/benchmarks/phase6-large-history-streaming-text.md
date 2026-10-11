# Large-history diagnostic: text streaming alone remains insufficient

Recorded 2026-10-11 with twelve requested frames, 9,992 HEAD files and forty commits.
The parent uses `--max-old-space-size=1536`. This attempt includes flat digest hex
conversion, chunked canonical hashing/exact comparison, shorter validation/indexed
working scopes and early adjacent-base eviction.

All eleven historical frames, layout and assembly completed before export failed with
`Allocation failed - JavaScript heap out of memory`. The final collection retained
approximately **1,409.8 MiB**, compared with roughly 1,491.1 MiB in the pre-streaming
attempt. These are different allocation-pressure points, not controlled retained-heap
measurements or evidence of a specific percentage improvement. Startup to failure was
approximately 200.6 s, including fixture generation and overlapping maintainer work;
it is not a p95/timing acceptance sample. No complete measured artifact was produced.

Streaming text removes whole-document strings but the delta encoder still builds the
full natural tables for both target and base while retaining the full indexed target.
It can also retain HEAD forms during adjacent-base work. The next correction matches
one base table at a time against one target row at a time, keeps only small key
projections across frames, and defers indexed working rows until matching ends.
Natural keys/forms, exact matching, diagnostic ordinals, canonical ordering, mandatory
round-trip verification and artifact format remain unchanged. No frame or budget is
dropped to make this gate pass.

See the [aggregate profile](phase6-large-history-heap-profile.md) and
[earlier diagnostic](phase6-large-history-1536mib-predecode.md). The fixed-build
full suite and complete resource-constrained measurements must be recorded separately.
