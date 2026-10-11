# Large-history bounded-parent completion diagnostic

Recorded 2026-10-11, runtime source `aa85c713aacec7967c243a8a8cf20e8a60dcf255`.
Prepared synthetic HEAD `43d5b0a23786ed81507a61504722b757fec4bdee`; 9,992 HEAD
files, forty mainline commits and twelve requested frames. The parent uses
`--max-old-space-size=1536`, matching the production V8 heap setting.

The diagnostic completes with **status complete and all twelve frames**. Its final
parent `process.memoryUsage()` reports RSS 1,659,457,536 bytes, heap used
1,307,862,640 bytes and array buffers 84,638,884 bytes. These are end observations,
not peaks; parser children and whole-job/kernel memory are not certified here.

Elapsed analysis is 283.94 s, but container building, fixture preparation and part of
a verification run overlapped it. This is not an isolated performance measurement,
not twenty samples and not a p95 pass. It does not meet or waive the 240 s requirement.

The combined changes in [ADR-036](../adr/ADR-036-export-base-cache-lifetime.md) remove
the observed parent-heap failure without dropping frames: exact canonical chunk
comparison/hashing, table-at-a-time natural matching, deferred indexed working rows
and decoder-key cache release. The previously committed Windows/Linux corpus hashes
remain exact in [CI 38115803254](https://github.com/urveesh09/project-atlas/actions/runs/38115803254),
which passes all eight jobs. Earlier failures are preserved, including the
[streaming-only attempt](phase6-large-history-streaming-text.md).

Next acceptance uses an immutable production image, no network, four-CPU quota,
2 GiB whole-job cgroup memory, disabled swap and the 1536 MiB parent heap. The runner
records kernel peak/OOM counters and requires twenty complete measured samples for a
pass. That resource/timing gate remains open until its actual report exists.
