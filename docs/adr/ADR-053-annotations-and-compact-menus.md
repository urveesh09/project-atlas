# ADR-053: Annotations (folder colours and notes), and compact city menus

Date: 2026-10-14. Status: accepted. Catch-up item 4 of [ADR-048](ADR-048-editions-and-free-parity.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

- **The gap.** CodeCharta lets users colour folders and keep the marking. ATLAS had no way
  to mark a part of the city or to leave a note for a teammate.
- **A first-screen regression.** Adding the Scope (ADR-051), Bands (ADR-052) and Notes
  menus pushed the city toolbar to four rows. On the 1366×768 demo the stage moved from
  y = 408 to y = 446, against the ADR-047 budget.
- **A contrast defect from ADR-049.**
  - The global `button { color: inherit }` (specificity 0,0,1) out-ranked the city's
    zero-specificity *primary* style.
  - An enabled primary button inside the city therefore drew dark text on the accent fill,
    at 2.27:1.
  - The earlier audits only saw that button disabled. The new notes test caught it with
    axe.

## Decision

1. **Marks.**
   - A folder or package can carry one of six named marker colours (red, amber, green,
     blue, purple, graphite) and a plain-text note of at most 500 characters.
   - Marks are made from the *Notes* menu while the folder or package is selected.
   - A mark tints its district surface in 3D and on the map, and every nested district
     inside it; the nearest mark wins.
   - Colour is never the only carrier:
     - the legend lists each marked path, and each entry selects it;
     - the selection card shows the note;
     - screen readers hear the colour name.
2. **Kept locally, shared as files.**
   - Marks live in this browser per repository (`atlas.notes.<repoId>`).
   - *Export notes* writes `atlas.notes/1`; *Import notes…* merges by path, newest wins,
     at most 200.
   - Imported files are untrusted:
     - paths and notes are bounded;
     - control characters are refused;
     - colours come from the allowlist;
     - notes are only ever rendered as text.
   - Nothing is sent anywhere. Exports list marked paths and colours in their metadata,
     and note text stays in the notes file.
3. **Compact menus.**
   - Where the city column is narrower than 900 px (a container query), the menu summaries
     (Scope, Bands, Saved views, Notes, Share) show their icon and a count badge.
   - The full label stays for assistive technology and as the tooltip.
   - The highlight field narrows with the column.
   - This restores the first screen.
4. **The contrast fix.** The global button reset is wrapped in `:where()`, so it has no
   specificity, and the city's control variants keep their own text colours.

## Verification

- `apps/web/test/annotations.test.ts` covers:
  - a round trip;
  - eight hostile entries skipped, with markup kept only as text;
  - the wrong format, invalid JSON and oversize files refused;
  - merge by path with the newest winning, sorted and capped at 200.
- The browser end-to-end test *marks a folder* covers:
  - a green mark with a note;
  - the legend entry and the card note;
  - local storage;
  - export as `atlas.notes/1`, removal and re-import;
  - an axe audit with the enabled primary button, which failed before the fix.

  The suite passes 36 of 36 on the GPU and with `CI=1`.
- vuejs/core demo, `@vue/runtime-core` marked red: the renderer reports 9 tinted
  districts.
- First screen, demo build:

  | Viewport | Stage top |
  |---|---|
  | 1366×768 | y = 408 (was 446 before the compact menus) |
  | 1920×1080 | y = 370 |
  | 390 px | y = 429 |
  | 320 px | y = 465 |

  No horizontal overflow.
- `pnpm verify` passes 676 tests; the baseline is exact.
