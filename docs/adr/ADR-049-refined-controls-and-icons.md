# ADR-049: Refined controls and a viewer icon set

Date: 2026-10-14. Status: accepted. Builds on [ADR-047](ADR-047-beta-2-activation-workspace-and-release-identity.md)
and [ADR-048](ADR-048-editions-and-free-parity.md). Changes no contract, artifact byte or
analyzer version.

## Evidence and cause

- **The owner's review (2026-10-14).** The viewer used basic buttons and dropdowns and
  should look refined.
- **What the beta showed.**
  - Selects used the operating system's arrow.
  - Buttons were flat boxes.
  - The stage controls were text glyphs (`←`, `⌂`, `⤢`, `N`, `◎`) that render differently
    by font.
  - Toggles were plain checkboxes.
- **A real styling defect.** The generic `.city button` rule had higher specificity than
  `.timeline-frame`, so every history dot under the stage was drawn inside a button box.

## Decision

1. **One control style.**
   - Tokens on `:root`, redefined for light mode, set a single surface, border, hover and
     shadow for every button, select and field: `--control`, `--control-hover`,
     `--control-border`, `--field`, `--accent-soft`, `--shadow-xs`, `--shadow-md` and
     `--ease`.
   - Variants:
     - *primary* is filled;
     - *ghost* and *quiet* show no chrome until hovered;
     - *accent* is tinted and marks the call to action;
     - *danger* is filled with the error colour.
   - `aria-pressed` buttons show their state with the accent tint.
2. **Specificity.** Inside the city, the shared style applies through `:where()`,
   including its states (`:where(.city button:hover:not(:disabled))`). It therefore has no
   specificity, and any component class (timeline dots, links, crumbs, menu items) wins
   without `!important`. This fixes the boxed history dots.
3. **Selects** use `appearance: none` with a chevron drawn from two gradients in the
   theme's muted colour, so it follows light and dark without an image.
4. **City toggles are switches.** The knob's position and the track's fill both show the
   state (WCAG 1.4.1). The control stays a native checkbox, so its role, label and
   keyboard behaviour are unchanged. Consent checkboxes in hosted forms stay checkboxes.
5. **Menus.**
   - *Saved views* and *Share* open from a button-like summary whose chevron turns while
     open.
   - Panels use the medium shadow and a short entry animation, removed under reduced
     motion.
   - Share actions are full-width menu rows with icons.
6. **Icons.** A small stroke icon set drawn for ATLAS (`apps/web/src/components/Icon.tsx`;
   24-unit grid, `currentColor`, `aria-hidden`) replaces the glyphs. The controls that hold
   icons keep their accessible names, so `Earlier` (formerly `‹ Earlier`) is the only name
   that changed.
7. **Stage controls** sit in two glass trays, one for the view and one for the camera,
   like a map's controls. Buttons are 36 px, or 44 px on coarse pointers.
8. **Text fields.** Focus shows an accent outline with a soft halo. The 2 px outline keeps
   at least 3:1 against the page in both themes.
9. **Space is unchanged.**
   - Header icons are hidden at 560 px and narrower.
   - Guided-start task icons appear only from 1500 px wide, where the cards keep one line
     per title.
   - The first-screen measurements of ADR-047 hold.

## Verification

- The demo build, measured with the page script used for ADR-047:
  - the stage starts at y = 408 at 1366×768 (unchanged);
  - at y = 370 at 1920×1080 (unchanged);
  - at y = 429 at 390 px (unchanged);
  - at y = 465 at 320 px (was 469).
- The page width equals the viewport at every width, and no header action is clipped, in
  both light and dark schemes.
- Viewer end-to-end tests pass 33 of 33 on the GPU and with `CI=1`, including the axe
  audits of the start screen, the workspace, the menus and the table.
- `pnpm verify` passes; the repository baseline is exact.
- Screenshots: `docs/images/beta2-{laptop,phone,workspace,map}.png` are replaced with the
  refined controls.
