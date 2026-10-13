# ADR-047: Beta 2 activation, workspace and release identity

Date: 2026-10-13. Status: accepted. Builds on [ADR-042](ADR-042-grounded-city-and-view-controls.md)
(view controls), [ADR-044](ADR-044-release-engineering-and-pilot-readiness.md) (demo site
and releases) and [ADR-045](ADR-045-pointer-picks-keyboard-driving-and-dependency-strokes.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

An external Beta 1 assessment of `677a19f` walked through the live demo and found:

1. **No purpose on arrival.** The page opened straight into the vuejs/core city with no
   statement of what it was or what to try. The history card and the toolbar pushed the
   city below the first screen. At 1366×768 the stage started at y = 572.
2. **Expand lost the work.** Expanded mode made only the canvas full screen, so search,
   lens controls, dependency options and the inspector were all out of reach.
3. **Units were missing from counts.** For one file the Overview said 23 direct
   dependencies and 7 consumers. Its Dependencies tab listed 24 imports and 12 consumers.
   All four numbers were correct, but they count different things: statements, unique
   files, value-only and type-inclusive.
4. **Findings had no clear subject.** A file's Findings tab mixed findings about the file
   with findings about other files that merely listed it, such as a hub's consumers.
5. **The page overflowed at 320 px.** The demo build was 337 px wide and its header action
   was clipped. CI tests the normal build, which has no demo button, so they missed it.
6. **2D map labels overlapped.**
7. **Export metadata could be lost.** One click started two downloads. In a normal
   browser the PNG arrived but the separate JSON was never found.
8. **The release identity was missing.** Packages said `0.1.0-dev`, no release existed,
   and START_HERE still said there was no public website.
9. **Public findings could not be checked against the source.** They named lines, but
   offered no way to see the committed code.

## Decision

1. **Guided start.**
   - A short panel above the city says what the analysis is: a demo, the repository, the
     commit, TS/JS only, and that nothing from the repository runs.
   - It offers three tasks, each naming a target derived from the analysis:
     - *Explore a package*: the package with the most files.
     - *Trace a file's dependencies*: the most-imported source file. It turns on both
       directions and opens the Dependencies tab.
     - *Compare two snapshots*: the last two.
   - Demo builds link to [Analyze your own repository](../guides/analyze-your-repository.md).
   - The panel can be hidden; the choice is a local preference, like the city style.
2. **The city takes the first screen.**
   - The heading is one line: repository, file and package counts, and the height rule.
   - The long decorative explanation sits behind *How to read the city*, on the legend line.
   - On wide screens, toolbar labels sit beside their controls. Zoom, North and Focus
     selection move onto the stage as a camera column; Reset city is the ⌂ button.
   - History is a compact strip under the stage. The commit window and the sampling
     explanation sit behind *How to read history*.
   - On screens up to 900 px wide the page scrolls as one, and the tree follows the city
     instead of being pinned beneath it. On phones, the stage comes right after its title.
   - Measured on the demo build, the stage now starts at y = 408 at 1366×768 (was 572) and
     at y = 370 at 1920×1080.
3. **Expand opens a workspace.**
   - The whole explorer goes full screen, or becomes a fixed overlay where full screen is
     refused. Search, the toolbar, the history strip and the inspector stay available.
   - The inspector becomes an evidence panel beside the city, toggled by ☰. The tree, the
     guided start and the long notes step aside.
   - F and Esc behave as before, and the selection is kept.
4. **Counts name their units.**
   - Overview: *Direct value consumers* and *Direct value dependencies*. Their definitions
     say these are unique files and exclude type-only imports.
   - Dependencies: a *Reading the counts* note reconciles the numbers, for example
     "24 internal import statements reach 23 files … 12 files import this one in any way,
     type-only included; 7 are direct value consumers".
   - The overlay note says it draws one relationship per connected pair and kind, never
     one per statement.
   - No data changed. The tab counts and section titles kept by tests are unchanged.
5. **Findings name their subject.**
   - A file's Findings tab lists *About this file* first: findings whose subject is the
     file, or a cycle that includes it.
   - *Findings about other files* follows, and each finding there says what it is
     *About*. The tab counts only the file's own findings.
6. **Reflow and labels.**
   - Header actions wrap below 560 px. Wide tables scroll inside themselves on small
     screens.
   - Map labels go through `placeMapLabels`: the selected file first, then its package,
     then larger packages. A label that does not fit drops its `@scope/`, then shortens
     with an ellipsis. A label that would collide or leave the canvas is skipped, with at
     most 24 labels.
7. **One export, provenance included.**
   - *Export PNG* writes the provenance JSON into the PNG as an uncompressed `iTXt` chunk
     with the keyword `atlas.provenance`. Image viewers ignore it; `exiftool` and ATLAS
     can read it.
   - *Export metadata* saves the same JSON as a separate, deliberate download.
   - Messages say a download was *started*, never that a file was delivered.
8. **Release identity.**
   - Every package is `0.1.0-beta.1`. The viewer shows its version in the header and in
     the Keys panel, with the analyzer and artifact versions.
   - The packaging script records the real workspace version, not a hard-coded
     `0.1.0-dev`.
   - `ANALYZER_VERSION` is unchanged, so analysis identities and the corpus baseline are
     unchanged.
   - START_HERE separates the public static demo, the CLI release and the undeployed
     hosted service.
9. **Exact public source links.**
   - For `public-github` analyses only, findings and files offer *Open on GitHub*. The link
     uses the analyzed commit (40 or 64 hex), the file's path in that snapshot and the
     line, with every segment encoded.
   - Nothing is fetched. Local and private analyses never get such links; they keep the
     verified local source panel.

## Verification

- `apps/web/test/png-text.test.ts`: the chunk round-trips UTF-8 JSON, every chunk CRC
  verifies, IEND stays last, and non-PNG input is refused.
- `apps/web/test/map-labels.test.ts`: 200 random rounds of 40 candidates place no
  overlapping or off-canvas labels and honour priority. A scope is dropped before an
  ellipsis.
- Browser end-to-end tests:
  - Export now expects one PNG download. An independent parser in the test reads its
    provenance, which must equal *Export metadata* apart from the camera.
  - The history summary is read after opening *How to read history*.
  - New suite *guided start and workspace*:
    - a task selects the target it names, with its tab and direction;
    - the counting note has units;
    - the panel hides and returns;
    - Expand keeps search, lens and inspector, and find → select works inside it;
    - the evidence panel toggles, Esc leaves with the selection kept, and the axe audit
      is clean.
- The demo build at 320, 390, 1366 and 1920 px wide has no page-wide horizontal scroll and
  no clipped header action.
- `pnpm verify`: 648 passed, 80 skipped. Browser end-to-end tests: 30 of 30 on the GPU
  and 30 of 30 with `CI=1` (SwiftShader).
- `pnpm verify:distribution`: passed, 6 stages, with the `0.1.0-beta.1` archive. The report
  from that run was not committed, because the tree was not yet clean; the release job
  regenerates it from the tag.
- Frame time on the GT 730 at 1366×768, demo build, three 120-frame orbits per state:
  p95 16.7–16.8 ms, the display cap, in all three styles, normal and expanded.
- Screenshots: `docs/images/beta2-*.png`.
