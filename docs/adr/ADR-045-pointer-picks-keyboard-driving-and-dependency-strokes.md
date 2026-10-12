# ADR-045: Pointer picks, keyboard driving and dependency strokes

Date: 2026-10-12. Status: accepted. Refines ADR-041 decision 8 and ADR-042 decision 8 (focus
after a selection) for pointer picks only. Changes no contract, artifact byte or version.

## Evidence and cause

The owner demoed the beta and reported three problems:
- **Every click on a building jumped the page to the top.** A city pick selected with
  `focusInspector`, so the inspector heading took focus. The browser scrolled the page to
  show it, moving the city partly out of view.
- **Moving around the city was hard.** Only mouse orbit, pan and wheel zoom existed.
- **Dependency lines were unclear.** They were 1-pixel WebGL lines in dark kind colours, with
  a small V at the target. It was hard to see where they ended, which file was at the other
  end, and whether a file imports the selection or is imported by it.

## Decision

1. **A pointer pick keeps focus and scroll where they are.**
   - Clicking a building (3D or 2D map) selects it without moving focus. The live region
     still announces it, and the city keeps keyboard focus.
   - On wide layouts the inspector beside the city is sticky, so its update is visible
     without scrolling.
   - Keyboard selection (search, tree, table, reach results) still moves focus to the
     inspector heading, as ADR-042 decided.
2. **Keyboard driving.** Clicking or tabbing to the city gives it focus (outlined); a key
   strip appears while it has focus. The keys are:

   | Keys | Action |
   |---|---|
   | arrows or W A S D | move forward, left, back and right over the ground |
   | Q and E, or Shift with left and right | turn |
   | Shift with up and down | tilt the view |
   | + and −, or Page Up and Page Down | zoom |

   - Movement eases in and out, and its speed scales with height above the city (capped,
     so a tap never skips a district). Reduced motion responds without the glide.
   - Driving cancels a camera flight; settled views join Previous/Next view.
   - Keys never act while typing in a control, and are released when the city loses focus.
3. **Dependency strokes.**
   - A selected file's relationships are drawn as screen-constant 3.4 px strokes over the
     city in their kind colour; type-only and dynamic stay dashed.
   - Each has a 24 px arrowhead at the imported target and a chevron midway.
   - A ring marks every connected building. The nearest 16 are named, without overlap,
     with a direction mark: `→` imported by the selection, `←` imports the selection,
     `↔` both.
   - Strokes, arrowheads and rings are three instanced draws with colours per instance.
     The overlay's 200-relationship cap and omitted counts are unchanged.
   - Nothing moves along the lines: the plan forbids animation that implies runtime
     traffic.

## Verification

- Vue walkthrough in Chromium (`drive.mjs`): the page was scrolled to show the city, then a
  building was clicked.
  - The main scroll position stayed at 248 before and after, and after the keys.
  - The inspector showed the picked file, its heading 112 px from the top.
  - Focus stayed on the city surface.
- Holding each key moved the camera on the expected axis. The first speed (0.85 x distance
  per second) moved about 140 units in 0.7 s from the establishing view, past an island
  about 100 units across. After the cap, the same press moves about 20 units.
- `renderer.ts` in vuejs/core with imports and consumers: 30 relationships drew 530 stroke
  segments, 60 arrowheads and 25 rings. Orbits with the overlay shown stayed at the
  16.7 ms cap (3 of 3).
- Vite at the stage, without an overlay: GPU 7.5–8.7 ms default and 11.5–12.2 ms close,
  every orbit at the cap.
- `pnpm verify`: 635 passed. Viewer e2e: 27 of 27 on the GPU and with `CI=1`, including the
  real spatial pick (which checks the inspector and tree, not focus).
- Capture: [dependencies of renderer.ts](../images/city-dependencies.png).
