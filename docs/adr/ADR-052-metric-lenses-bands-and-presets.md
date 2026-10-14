# ADR-052: More metric lenses, editable bands, distribution and built-in views

Date: 2026-10-14. Status: accepted. Catch-up item 3 of [ADR-048](ADR-048-editions-and-free-parity.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

- **What CodeCharta offers.** You choose the metric for area, height and colour, adjust
  thresholds, see a distribution chart, and start from built-in scenarios.
- **What ATLAS offered.** Five fixed colour lenses with fixed bands. The artifact already
  carries more per-file metrics, which the viewer did not offer as colours: code lines,
  total complexity, callables, fan-out, and lines added and deleted.

## Decision

1. **Ten colour lenses**, grouped in the picker. Every value is read from its own artifact
   field; unknown stays unknown.

   | Group | Lens | Field |
   |---|---|---|
   | Structure | Package structure | package |
   | Size | Code lines | `codeLines` |
   | Size | Functions and methods | `callableCount` |
   | Complexity | Max callable complexity | `maxCyclomatic` |
   | Complexity | Total complexity | `sumCyclomatic` |
   | Dependencies | Fan-in | `fanIn` |
   | Dependencies | Fan-out | `fanOut` |
   | History | Changed commits | `changedCommits` |
   | History | Lines changed | `linesAdded + linesDeleted`; unknown when either is null or history is unavailable |
   | History | Hotspot or structure attention | as before |

2. **Height and area stay fixed.**
   - Height stays code lines (plan §11.5), so the shape of the city keeps one meaning.
   - Plot area stays the history-stable layout ([ADR-008](ADR-008-latest-path-anchors-for-stable-historical-plots.md)), so any lens can be compared
     across snapshots.
   - This differs from CodeCharta on purpose, and the comparison says so.
3. **Bands.**
   - A *Bands* menu shows the distribution over the files shown as one bar per colour
     band, plus unknown. Next to it: the count with a value, median, 90th percentile and
     maximum.
   - The four band starts after 0 can be edited. An invalid edit is reported and the last
     valid bands stay in use.
   - *Even split* uses quintiles of the files shown, rounded up and raised past ties.
     *Reset* returns to the defaults.
   - Values are never rescaled.
   - Custom bands recolour through the `CityPaint` hook of ADR-050. The legend, its counts
     and the exports show the bands in use; metadata gains `lensBands`.
4. **Built-in views.** The Saved views menu starts with seven presets that set only a lens
   and a display filter:
   - hotspots (or attention);
   - largest files;
   - most complex;
   - most depended on;
   - most dependencies;
   - most changed;
   - tests.
5. **Saved views store custom band starts** for their lens, as `stops`. They are validated
   as five ascending whole numbers from 0, at most 1,000,000. Older views keep the
   defaults.

## Verification

- `packages/layout/test/view.test.ts` checks:
  - each new lens reads its own field;
  - lines changed is unknown when a side is null or history is unavailable;
  - custom stops recolour;
  - every lens has five ascending stops from 0.
- `apps/web/test/bands.test.ts` checks:
  - validation;
  - one band per value, with unknowns apart;
  - 300 random distributions, with and without heavy ties: *Even split* always gives valid
    bands, and spread values never put more than half the files in one band.
- `saved-views.test.ts`: valid stops are kept; seven malformed forms are refused.
- The browser end-to-end test *colours by any metric*:
  - the distribution chart is labelled with counts;
  - a band edit changes the legend while the counts still sum to the files;
  - an invalid edit is reported and the previous bands kept;
  - *Even split* and *Reset* work;
  - two presets set lens and filter;
  - an axe audit passes with the menu open.

  The suite passes 35 of 35.
