# ADR-059: Interface second pass: honest job stages, readable summaries, fitting panels

Date: 2026-10-15. Status: accepted. Follows [ADR-058](ADR-058-interface-polish.md). Changes
no contract, artifact byte or analyzer version. The city is unchanged.

## Evidence and cause

ADR-058 reviewed the entry screens and the explorer's first view. A second review covered the
remaining surfaces:
- the hosted job page in each state, with the API mocked in the browser;
- the unavailable page;
- the explorer's other states: file inspector, keys panel, compare, map, table, package graph
  and phone layout.

It found:

- **Failed and cancelled jobs ticked every stage as done,** including "Verify and publish".
  The worker clears the stage when a job fails or is cancelled (`stage=NULL` in
  `apps/worker/src/queue.ts`), and the page counted a terminal job without a stage as past
  the last stage.
- **Package graph nodes overflowed:** "39 files · 78 internal" ran past its box.
  - Node width came from the name alone; the counts line had fitted only because the old
    system monospace was narrow.
  - ADR-058's Geist Mono is wider, so this was our regression.
- **Stale copy:** the Measurements section still said "an em dash means not available" after
  ADR-058 replaced the dash with "n/a".
- **The measurements table was wider than the inspector column** (330px), so its Definition
  column scrolled sideways inside the panel ("LF-delimit…").
- **Long summary lines chained three to five middle dots,** for example "Snapshot 12 of 12 ·
  2026-09-18 · 4ab865a · 702 files · selected commit". Affected:
  - the history line and its help;
  - the overview line;
  - the version line in the Keys panel;
  - the availability line;
  - the package-graph summary;
  - the bands summary.
- The job page's "New analysis" action had no border or fill, as the landing's secondary
  action had before ADR-058.

## Decision

1. **No stage claims without a stage.** A failed or cancelled job without a stage shows "It
   stopped before a result was published." (or "It was cancelled before…") instead of a stage
   list.
   - The page does not guess from the last stage it saw, because polling can miss later
     stages.
   - A job that fails while its stage is known still marks that stage as stopped.
2. **Nodes fit both lines.**
   - `packageMeta(files, internalPairs)` builds the counts line, now joined with a comma.
   - `buildPackageGraph` sizes each node by the wider of the name and that line. The meta
     estimate is 6.2px per character, which covers Geist Mono at 10px.
3. **Copy:** "Raw values; n/a means not available, never zero."
4. **Inspector tables wrap.** Inside `.city-inspector`, tables use fixed layout with a 5em
   value column, and cells wrap. Nothing scrolls sideways.
5. **Summary lines are sentences,** with at most one middle dot.
   - The words that tests and readers rely on stay ("12 mainline commits", "12 analyzed
     snapshots", "first commit", "selected commit").
   - Dense data rows (for example "interface · exported · line 96") keep their separators,
     where they work as columns. The city stage is untouched.
6. "New analysis" on the job page is a bordered button.

## Verification

- **Job page, original failure and retest:**
  - The hosted failure and cancellation journeys now assert no "done" stage and the stopped
    sentence.
  - Against the previous job page both fail ("expected 7 to be 0"). With this change the
    hosted journeys pass 6 of 6, twice, on PostgreSQL 17.
- **Package graph:**
  - A unit test pins the width rule: a short name with long counts takes the counts line's
    width.
  - In Chromium every node's text, measured with `getBBox`, fits its box with at least 4px on
    each side: 0 of 18 nodes overrun, in both themes.
- **Inspector:** zero horizontal overflow at 1440, 1280 and 1024px with a file selected.
- **City:** the stage captures byte-identical to the pre-ADR-058 baseline in 3D and map, dark
  and light.
- **End-to-end:** the viewer suite passes 39 of 39, also with `CI=1`. The package-graph test's
  summary pattern now reads "packages, … dependencies".
- **Repository checks:** `pnpm verify` passes with 712 tests, and
  `check-repository-baseline` preserves all three corpus repositories.
