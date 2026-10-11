# Large-history diagnostic before export-cache release

Recorded 2026-10-11. This is a **diagnostic warm-up**, not a 20-run p95 report.

The first attempted large-history batch used 9,992 HEAD files, forty commits and twelve
requested frames on the Windows/i5-10400/16 GiB development host, Node 24.15.0 and two
parser children. Existing analyzer/artifact behavior was commit `7395fb8`; the benchmark
driver's tier/completeness reporting was uncommitted. No other analysis or browser
benchmark was running. The warm-up took **260.41 seconds** after acquisition.

At 2026-10-11 04:48:37 UTC, the benchmark parent alone had **3,475.10 MiB working set**,
measured externally with Windows process counters. This is one observation, not a
sampled peak or a total-job measurement, and excludes parser children. It exceeds the
plan's 2 GiB whole-job budget before those children are counted. Eleven historical-frame
progress events completed alongside HEAD; no baseline artifact-size result was retained.

The batch was stopped during its first measured iteration to investigate retention.
It has **zero retained complete measured samples**, so it cannot establish p95 success
or failure against 240 seconds. The memory observation is enough to flag a capacity concern.
The interrupted fixture was not substituted for a passing artifact/report.

Inspection found that `packArtifact`'s WeakMap cache kept natural row strings for every
adjacent base even after its final use: all input graphs remained strongly retained by
the output bundle. The cache now explicitly releases those historical bases while
retaining the reused HEAD base; round-trip comparison remains mandatory. The benchmark
also releases its preceding result before the next cold analysis, matching one dataset
per production sandbox. [ADR-036](../adr/ADR-036-export-base-cache-lifetime.md) records
the correction and its verification boundaries.

A fresh batch with a 1,400 MiB parent V8 heap is reported separately. That heap setting
does not by itself enforce a 2 GiB total process-tree/cgroup budget or four CPU cores.
