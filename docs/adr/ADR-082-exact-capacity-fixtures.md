# ADR-082: Exact capacity fixtures at the analyzer's ceilings

Date: 2026-10-20. Status: proposed; exact-head CI and owner merge required. Production
M5.2, for gate G6 and review item R6-01. The fixtures are TypeScript; the Python and mixed
near-limit rows stay as in [ADR-081](ADR-081-python-capacity.md).

## Evidence and cause

**R6-01 named fixtures that did not exist.** Plan §15.1 defines the large tier as 10,000
files and 100,000 edges, a temporal union of 20,000 lineages with at most 10,000 present
per frame, and a dense fixture that "exercises degree/edge caps". ADR-035 and ADR-037
record them as open. The capacity tools only built the near-limit fixture: 9,992 HEAD
files, 98,500 imports and 9,999 lineages, from randomly sampled imports whose edge count
is only known after analysis. A reviewer could not run R6-01 as written.

**Building them found defects.** The first diagnostics on analyzer dev.9:
- the dense HEAD (30 imports per module) failed export with an unclassified `SCHEMA`
  error;
- the exact history took 888 s in the 4-CPU/2-GiB container and exported 6 of 12 frames.

[ADR-083](ADR-083-fit-the-export.md) records the causes and the fixes.

## Decision

1. **A generator that constructs every count** (`scripts/lib/exact-capacity.mjs`, policy
   `atlas.capacity.exact/1`), deterministic and TypeScript:
   - **exact:** 40 mainline commits over 58.5 days. Each of the 12 frames that
     `selectFrameIndices` selects holds exactly 10,000 included files and 100,000
     dependency edges, and together they hold exactly 20,000 lineages.
     - Stable modules (2,000) are the only import targets and never move.
     - Churning modules are leaves, replaced first in, first out. They are deleted one commit
       after a frame and succeeded by new paths in the next, so no diff can pair them as
       renames.
     - Each module has 10 distinct imports, and 1,420 stable modules have 11.
     - Frame commits rename seven churning modules within their directory (77 renames).
     - About 40 body edits per commit, skewed towards hot modules, never change imports.
   - **exact HEAD:** the final tree of the same history as one commit.
   - **dense:** one commit of 10,000 files.
     - Every module imports ten hub modules (fan-in 9,857) and 30 distinct targets in all:
       295,740 observations.
     - That exceeds the edge ceiling (exactly 195,740 edges omitted), the 250,000-row
       evidence ceiling and the decoded chunk ceiling.
2. **The benchmark checks the constructed counts in every sample.**
   - `build-history-fixture.mjs --shape exact|dense` records the counts in the fixture.
   - `bench-history(-container).mjs --shape` requires them sample by sample, beside the
     unchanged time, size, resource and 20-sample gates.
3. **Pass rules:**
   - **Exact HEAD:** complete, with 10,000 files and 100,000 edges.
   - **Exact history:**
     - every kept frame holds its 10,000 files and 100,000 edges, with no limit hit;
     - the history records all 20,000 lineages and 77 renames;
     - frames may be dropped only for `ARTIFACT_SIZE`. Plan §15.2 sets the large artifact
       at "≤ 20 MiB hard transport limit after frame reduction". This fixture replaces half
       its files across the window, so 12 such frames cannot fit 128 MiB stored. The
       analyzer keeps the newest frames that fit, and the report states how many.
   - **Dense HEAD:** partial, with exactly `EDGE_LIMIT` and `EVIDENCE_LIMIT`, every
     observation counted, 100,000 edges kept and the exact edge omission.
   - All three use the large budgets: 60 s HEAD and 240 s history at p95, 20 MiB, and 2 GiB
     with no memory events.
4. **The near-limit fixtures and their reports are unchanged** and stay comparable with
   earlier evidence.
5. **Oversized chunks are size limits.** The packer reports a chunk over the per-chunk
   ceiling as `LIMIT`, not `SCHEMA`, so analysis applies its size handling (ADR-083).

## Verification

- **Generator tests** (`exact-capacity.test.ts`):
  - the frame indices equal `selectFrameIndices(40, 12)`;
  - replaying the commits gives 10,000 files and 100,000 distinct, resolvable imports in
    every frame and 20,000 lineages across them;
  - no deleted path returns, and no renamed module is imported;
  - output is deterministic;
  - at a reduced scale (600 files, 3,000 edges, 1,200 lineages) the real analyzer reports
    exactly the constructed counts in all 12 frames;
  - the dense fixture's statements and hub fan-in.
- **The `LIMIT` classification** has a unit test.
- **A one-sample dense HEAD check at 13 imports per module**, outside the container,
  reproduced every constructed count: 100,000 edges, 28,154 omitted and 128,154
  observations.
- **Container diagnostics, 2026-10-20** (one warm-up run each in the 4-CPU/2-GiB/no-swap
  offline container, `--diagnostic-once`; they report time and memory, not the
  constructed counts, and are not acceptance samples):

  | Fixture | Image source | Time | Frames | Job peak | Memory events |
  |---|---|---:|---:|---:|---|
  | Exact history | dev.9 (`16d1147`) | 888.46 s | 6 | 1,970,372,608 B | none |
  | Exact history | dev.10 (`bf6f282`, ADR-083) | 144.63 s | 6 | 2,072,801,280 B (96.5%) | none |
  | Exact history | dev.10 (`d4837fd`, ADR-084) | 150.57 s | 6 | 1,769,410,560 B (82.4%) | none |
  | Dense HEAD | dev.10 (`d4837fd`) | 44.18 s | 1 (partial) | 1,598,824,448 B (74.4%) | none |

- **The 20-run rows** (exact HEAD, exact history, dense HEAD), which check the constructed
  counts in every sample, are pending; they run from a clean checkout of the merged commit.
