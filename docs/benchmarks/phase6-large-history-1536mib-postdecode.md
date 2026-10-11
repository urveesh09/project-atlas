# Large-history production-heap diagnostic: post-round-trip eviction

Recorded 2026-10-11 using `--max-old-space-size=1536`, 9,992 HEAD files, forty commits
and twelve requested frames. This attempt used the first cache correction (`14b41ad`),
which released adjacent-base forms **after** the mandatory decoder round trip.

The warm-up emitted eleven historical-frame completions, then failed with
`Allocation failed - JavaScript heap out of memory`. V8 reported roughly **1,489.8 MiB**
retained after its final collection. The failure occurred about 174.7 seconds after
process startup, including fixture generation; this is not an analysis/p95 timing.
No complete measured sample or artifact was produced.

Unlike the 1,400 MiB experiment, this matches the production worker's parent heap
setting. It demonstrates that post-round-trip eviction alone is insufficient for this
fixture. The next correction releases single-use base **forms before decoding** and
retains only the keys the decoder needs, reducing overlap with the reconstructed graph.
It preserves exact round-trip verification and HEAD reuse. No memory/latency budget is raised.

The [original diagnostic](phase6-large-history-precache.md) and [stricter diagnostic](phase6-large-history-1400mib.md)
remain available. These failures leave large-history capacity acceptance open until
a complete measured batch and total-job reference verification pass.
