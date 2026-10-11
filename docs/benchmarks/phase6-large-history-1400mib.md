# Large-history 1,400 MiB parent-heap diagnostic

Recorded 2026-10-11 after the adjacent-base cache correction, with the same 9,992-file,
forty-commit fixture and twelve requested frames. Command:

```sh
node --max-old-space-size=1400 scripts/bench-history.mjs --files 9740 --runs 20 --out phase6-large-history-capacity
```

The warm-up emitted all eleven historical-frame progress completions, then the process
failed with `Allocation failed - JavaScript heap out of memory`. Near termination,
V8 reported about 1,350.9 MiB retained heap after collection. One external Windows
observation recorded 1,538.80 MiB parent working set. No complete measured sample or
artifact was produced, and no p95 gate is claimed.

The worker's actual parent heap argument in `apps/worker/src/runners.ts` is 75% of
the 2 GiB sandbox memory limit, or **1,536 MiB**. The 1,400 MiB diagnostic is stricter;
its failure alone does not establish the corrected production profile fails. The next
batch uses the worker's actual parent heap setting. Reference whole-job/cgroup memory
still needs measurement; a V8 heap argument does not certify process-tree RSS.

The original unbounded-parent [diagnostic](phase6-large-history-precache.md) and this
failure are preserved. Neither is substituted for a completed twenty-run report.
