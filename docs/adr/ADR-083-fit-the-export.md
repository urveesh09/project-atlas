# ADR-083: Fit the export to its limits quickly, and degrade instead of failing

Date: 2026-10-20. Status: accepted, merged in [PR #49](https://github.com/urveesh09/project-atlas/pull/49) on 2026-10-20. Production
M5.2. Supersedes the "reject" half of
[ADR-024](ADR-024-decoded-artifact-capacity.md) for a selected graph whose evidence alone
exceeds the decoded ceiling; the 128 MiB decoded and stored ceilings and the 20 MiB
compressed ceiling are unchanged. Analyzer `0.1.0-dev.9` → `0.1.0-dev.10`; artifact and
graph schemas are unchanged.

## Evidence and cause

The exact capacity fixtures of [ADR-082](ADR-082-exact-capacity-fixtures.md) exposed three
defects that the near-limit fixtures never reached.

1. **Frame reduction was too slow for any deadline.** The exact large history (12 frames of
   10,000 files and 100,000 edges, 20,000 lineages) analyzes all frames in 62 s in-process,
   then needs 7 pack attempts to fit the artifact: each one re-assembled and re-encoded
   every frame (about 7.5 s per 107 MB frame graph, mostly canonical writing and the
   decoder round-trip proof), only to drop the oldest frame and try again.
   - In-process: 514 s in total. In the 4-CPU/2-GiB container: **888 s**, with a cgroup
     peak of 1,970,372,608 bytes and no OOM. The budget is 240 s; the hosted sandbox is
     killed at 300 s, so such a repository would lose its history entirely.
   - Profile of one full attempt (90.4 s, 12 frames): no single hot spot; canonical
     writing 17.3 s, GC 10.3 s, canonical comparison 4.4 s, hashing 6.4 s, delta matching
     and validation make up the rest. The waste is repeating it.
   - All 12 frames do not fit (213 MB stored, 22.8 MB compressed): the selected graph is
     52.9 MB and the keyframes that are deltas against it are 16.2–42.5 MB, because half
     the files are replaced across the window. Six frames fit (112.8 MB, 12.9 MB).
2. **Frame reduction did not reserve time to export.** Frames were analyzed until the
   deadline, and assembly and packing then ran unbounded after it.
3. **A dense selected graph failed outright.** A 10,000-file HEAD with 30 distinct imports
   per module (295,740 observations) failed export with an unclassified `SCHEMA` error,
   not even the designed `ARTIFACT_SIZE`: the decoded graph chunk exceeded 134,217,728
   bytes. Measured on 13 imports per module (100,000 edges, 128,154 observations): an
   observation costs about 511 canonical bytes and an edge about 419, so at the edge and
   evidence ceilings (100,000 and 250,000 rows) a graph is about 180 MB. The evidence-row
   ceiling cannot be reached at 10,000 files without breaking the decoded ceiling.

**Each frame's final graph is independent of which other frames are kept.** Churn is
accumulated over the window's commits (`churnByFrame` only selects which frames to report),
the hotspot baseline is the selected frame's, and recovery warnings belong to the frame. A
delta's base depends only on the number of newer kept frames. So the chunks of the frames
that are kept never change when older frames are dropped; only history, layout and the
manifest do.

## Decision

1. **Encode frames as they complete, newest first.** Each frame's final graph is derived
   once, right after its analysis, and its chunk is encoded into a per-analysis
   `FrameChunkCache` keyed by graph and base object. A chunk is a pure function of those
   two graphs, so reuse is byte-identical by construction.
2. **Stop expanding history at the first frame that cannot fit.** The running size of the
   kept frames' chunks leaves out history and layout, so a frame that does not fit here
   never fits; it and every older frame are unavailable with `ARTIFACT_SIZE`, and older
   frames are not analyzed. The lineage cap is applied the same way (`LINEAGE_LIMIT`):
   frames join newest first, so the union only grows.
3. **Then drop the oldest frames one at a time, as before**, until history and layout fit
   beside them. Each step re-encodes only history and layout; kept frames come from the
   cache. The frames kept are exactly those of the previous rule.
4. **Pack newest first and stop early.** `packArtifact` encodes history and layout, then
   frames newest first, and reports how many frames fit (`ArtifactPackError.fit`) at the
   first one that would exceed a limit. Within the limits its output is unchanged.
   Oversized chunks are reported as `LIMIT` (ADR-082), not `SCHEMA`.
5. **Reserve time for the export.** With packing, frame expansion stops while there is
   still time to assemble and pack the kept frames, estimated from the selected frame's
   measured export time: `(2 + 0.25 × kept frames)` times it, plus one frame step.
6. **A selected graph that cannot fit keeps fewer evidence rows instead of failing.** When
   the selected frame's chunk exceeds the decoded ceiling, the analysis is re-derived from
   cached facts with fewer evidence rows, lowest IDs first, counted under `EVIDENCE_LIMIT`.
   - The row count comes from the exact canonical size of each dropped row and of its
     reference in a kept edge, plus a margin of 1% of the excess and 1 KiB; the result is
     re-checked, so one re-derivation normally fits.
   - Edges and their observation counts are unchanged; findings that cite a dropped row go
     with it. The graph is `partial`.
   - Only when no evidence at all would fit does analysis fail, with `ARTIFACT_SIZE`.
   - This supersedes ADR-024's rejection of such graphs: a dense repository gets a city
     with explicit evidence omissions, which is more useful than no result.
7. **Export limits can be lowered, never raised** (`AnalyzeCommitInput.exportLimits`), for
   tests and operators. They are not analysis options and do not change options digests.
8. **Analyzer `0.1.0-dev.10`.** Over the limits, results change: frames past the stop are
   not analyzed and carry the stop's reason, and dense selected graphs keep fewer evidence
   rows. Below the limits nothing changes but the version.

**Not changed:** the artifact format, its ceilings and the delta base rule. A size-aware
choice of delta bases could keep about one more frame of the exact fixture; it would need
trial encodings and is left for later.

## Verification

- **Below the limits, output is unchanged.** With the refactor and before the version bump,
  all 264 analyzer, artifact and CLI tests pass, including the Harbor cross-platform
  digest golden. After the bump only version-derived values change: the Harbor golden,
  and the six pinned repositories, where the path comparator against `main`'s dev.9 build
  finds exactly one difference per repository, the analyzer version.
- **New tests** (`export-fit.test.ts`, on Harbor with lowered limits):
  - the newest frames that fit are kept, each canonically identical to the unlimited
    analysis, and the others are `ARTIFACT_SIZE`;
  - with everything fitting, the chunks equal the unlimited artifact's;
  - a selected graph over the decoded ceiling keeps the lowest-ID evidence rows, every edge
    and observation count, and reports the exact `EVIDENCE_LIMIT` count;
  - an impossible limit fails with `ARTIFACT_SIZE`.
- **Exact large history, in-process with the production 1,536 MiB heap:** **124.7 s**
  instead of 514 s, with the same artifact totals (6 frames, 112,751,293 stored and
  12,921,106 compressed bytes). Three frames were never analyzed; the two history/layout
  drops took about 4.5 s each.
- **Dense HEAD with 30 imports per module, in-process:** 43.6 s, partial, one
  re-derivation, decoded selected chunk 133,023,655 bytes (0.9% under the ceiling).
- Container measurements are recorded in ADR-082.
