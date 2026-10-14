# ADR-050: Change colouring in Compare

Date: 2026-10-14. Status: accepted. Builds on [ADR-048](ADR-048-editions-and-free-parity.md),
whose catch-up list puts this first, and on the two-frame comparison of plan §7.4. Changes no
contract, artifact byte or analyzer version.

## Evidence and cause

- **The gap.** CodeCharta's delta mode colours a map by how a metric changed between two
  loaded maps. In a comparison, ATLAS listed exact differences (added, deleted, renamed,
  changed files and metric changes), but its city kept the lens colours. The size of a
  change was visible only in lists.
- **The data already existed.** The comparison computed in the query worker
  (`compareFrames`, `packages/graph/src/compare.ts`) carries `metricChanges`: a signed delta
  per lineage for ten metrics. When either side is unknown, it records a null delta with the
  side that is missing. Nothing new has to be analysed.
- **A layout defect.**
  - The cause: with the explorer beside the inspector (wider than 1350 px), the content
    grid's auto rows could shrink to the city's minimum height, because the city clips its
    overflow and the explorer column has a fixed height.
  - The effect: when the tall compare panel opened, the city's row shrank to 30 px and the
    panel covered the city.
  - Measured on the vuejs/core demo at 1440×900: grid rows 107 | 30 | 3325 px, city top
    208 px, compare top 272 px.

## Decision

1. **Colour by change.**
   - While a comparison is ready and its snapshot B is on screen, a *Colour* select offers
     *Lens values* or the change in one of six metrics: code lines, max complexity, total
     complexity, fan-in, fan-out and hotspot score.
   - It defaults to code lines for each new comparison. Choosing a lens returns to lens
     colours.
2. **Bands.** The bands come straight from the comparison: `to − from` for each lineage;
   nothing is estimated.
   - **Changed:** below 0 is *less*, and −strong or below is *much less*; above 0 is
     *more*, and +strong or above is *much more*. The strong threshold depends on the
     metric:
     - code lines 50;
     - max complexity 5;
     - total complexity 10;
     - fan-in 5;
     - fan-out 5;
     - hotspot score 10.
   - **Unchanged:** a lineage with no recorded change whose value in B is known.
   - **New:** a lineage absent from A. It also keeps its raised compare marker.
   - **Unknown:** a value unknown on either side, drawn with the missing-value cross. It is
     never shown as unchanged.
3. **Colours.**
   - A diverging blue–orange scale, readable with red–green colour blindness: blue is less,
     orange is more, and unchanged is a light neutral, so changes stand out.
   - New files are purple; unknown keeps the lens grey.
   - Colour is never the only carrier: the legend names every band with its threshold and
     count.
4. **The numbers are shown, not only coloured.**
   - The hover card and the selection card show the change, for example "+12 (40 → 52)".
   - The file table gains a column with the signed change for every file.
   - The PNG attribution names the change metric.
   - Export metadata gains `changeColour`: the metric and the files in each band.
5. **One colour hook.** `CityPaint` (`apps/web/src/city/types.ts`) lets colours replace the
   lens colours in both renderers. Its `key` triggers a recolour, and its `unknown` drives
   the missing-value cross. The 3D labels drop their package swatches while a paint is
   active.
6. **The layout fix.** `.city-content` rows are `max-content`, so the compare panel always
   follows the city.

Saved views do not store change colouring, because they do not store comparisons
(ADR-048). That stays a separate decision.

## Verification

- `apps/web/test/change-colours.test.ts` covers:
  - every band, including both unknown cases and new files;
  - counts that sum to the files;
  - colours and labels, and signed formatting;
  - for each of the six metrics, 400 random metric pairs passed through the graph package's
    own `metricDeltas`: every known delta equals `to − from`, its band follows the
    thresholds, and every unknown side stays unknown.
- The compare scenario of the browser end-to-end suite covers:
  - change colouring on by default, with the renderer reporting the paint key;
  - seven legend bands summing to the buildings of B, four of them new;
  - switching to fan-in, and the table column with signed values;
  - picking a lens returns to lens colours;
  - at 1440×900, the compare panel starts below the city.
- On the vuejs/core demo, comparing snapshots 11 → 12 in code lines gives:
  - 514 unchanged;
  - 9 *more*;
  - 4 *much more*;
  - 175 unknown, the files that are not TS/JS;
  - in all, the 702 files of B.

  After the layout fix, the grid rows at 1440×900 are 107 | 1218 | 3325 px and the compare
  panel starts at 1459 px, below the city's bottom at 1398 px.
