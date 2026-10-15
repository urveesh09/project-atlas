# ADR-058: Interface polish: one type face, one shape rule, entry screens that show the city

Date: 2026-10-15. Status: accepted. Changes no contract, artifact byte or analyzer version.
The city itself (renderer, stage, labels, exports) is unchanged.

## Evidence and cause

An audit of the viewer on `main` (dark and light, 1440×900 and 390×844) found these problems:

- **The page itself scrolled.**
  - At 1440×900 the document was 5,245px tall, so a mouse wheel over the header slid the
    explorer off screen and showed an empty page.
  - Cause: 212 visually hidden tree labels (`.sr-only`, absolutely positioned) were placed
    against the page, because the sidebar that scrolls them was not a positioning container.
- **The overview's findings list stopped at 20 without saying so,** under a heading that
  counts all of them (132 on the demo).
  - The inspector was 12,157px long at 1440px.
  - Each card repeated its rule's general explanation.
- **Small defects:**
  - the "complete analysis" pill broke across two lines;
  - the disabled "Analyze repository" button was hard to read in light mode;
  - "Open a local artifact folder…" had no border or fill, so it did not read as a button;
  - the repository URL placeholder was clipped on phones.
- **Inconsistency:**
  - 15 hard-coded corner radii beside the two tokens;
  - system fonts that differ by platform;
  - 11px help text;
  - eight visible em or en dashes;
  - two labels for one action ("Your repository", "Analyze your own repository →").
- **Entry screens and sharing:**
  - The entry screens were text-only cards, although the product's output is visual.
  - Every page was titled "ATLAS", with no description, favicon, link-preview card or
    no-JavaScript text.

## Decision

A preserving evolution, with the same brand, information architecture, URLs, form fields and
legal copy:

1. **Containment.** Every scroller (sidebar, content, inspector, source panel) is a
   positioning container, so hidden labels stay inside it. The page no longer scrolls on
   desktop; each panel does.
2. **Type.**
   - Self-hosted Geist and Geist Mono (Fontsource variable, 5.3.0, OFL-1.1). They are
     bundled with `unicode-range` subsets (Latin 29 KB and 23 KB), so the viewer stays
     offline.
   - The city stage keeps the system faces it was designed with.
   - Help and legend text moves from 11px to 12px.
3. **Shape rule.**
   - `--radius-xs` 4px for swatches and keys, `--radius-sm` 7px for controls, fields and
     rows, `--radius` 10px for panels, cards and menus, and `--radius-lg` 14px for
     page-level surfaces. Pills are 999px and dots 50%.
   - The stage's own overlays keep their shapes.
4. **States.**
   - A disabled primary button is a neutral control with muted text, about 7:1.
   - Status pills, chips and badges never wrap.
   - The secondary hosted action is a bordered button.
5. **Findings.**
   - The overview lists 5 findings, then 20 more per click, and states how many remain.
   - Folder and package lists page at 10.
   - In those lists the rule's explanation sits behind "Why this is flagged"; a file's own
     findings always show it.
6. **Copy.**
   - No em or en dashes in visible text: sentences use commas, colons or parentheses, and
     ranges use a hyphen.
   - An unavailable number reads "n/a".
   - A moved file's empty folder reads "repository root".
   - One label for the action: "Analyze your repository".
7. **Entry screens.**
   - The local start screen and the hosted landing pair their card with a real render of the
     demo city (vuejs/core at 4ab865a). Below 960px the image stacks under the card.
   - The image is the viewer drawing the demo artifact, not a mock-up.
   - The card and image of the two entry screens rise in once, and only without reduced
     motion.
   - The rise moves without fading, so text never passes through low contrast. Job, result
     and error pages appear at once.
   - Entry screens start at most 96px from the top instead of floating mid-window.
   - The second route ("Or run `atlas serve`…") sits under the card, not under its button.
   - The page keeps one header row from 1024px up:
     - between 561px and 1180px the version moves to the Keys panel, where it is always shown;
     - the tree and keys toggles show only their icon, keeping their accessible names and
       tooltips;
     - the search field yields width first.
8. **Pages and sharing.**
   - The title reads "ATLAS: your codebase as a city" and, in the explorer, "<repository>
     as a city · ATLAS".
   - The page also has a description, light and dark theme colours, a favicon from the
     brand diamond, Open Graph and Twitter tags, and `<noscript>` text.
   - `build-demo-site.mjs --site-url` adds what needs the public address: a canonical link,
     an absolute 1200×630 social card, and `SoftwareApplication` structured data.
   - The demo workflow passes the Pages address through an environment variable.
   - Both static servers serve `.webp` as `image/webp`, because `nosniff` requires the exact
     type.

## Verification

- **The city is unchanged.** The stage (900×560) was captured before and after in 3D and
  2D-map views, dark and light: all four captures are byte-identical. Two runs before the
  change were also identical, so the capture is deterministic.
- **End-to-end.** The viewer suite passes 39 of 39, also with `CI=1`, including the axe AA
  checks. It gains these checks:
  - the page does not scroll at 1280×860, and a wheel over the header leaves `scrollY` at 0;
  - the explorer title names the repository;
  - the start screen's image loads at 1120px wide with a description, under the new title.
- **Original failure, cause and retest.**
  - The first version collapsed explanations on every card. Journey J3 failed, because it
    expects a file's own finding to explain itself ("not a runtime deadlock").
  - Explanations now collapse only in lists, and J3 passes.
- **CI failure, cause and retest.**
  - The first push failed *hosted service gates*. The hosted Chromium journey's axe audit
    found "Start a new analysis" at 2.51:1 on the deleted-analysis page.
  - Cause: the entry animation faded every gate card in from transparent, so axe sampled
    blended colours (`#82a3b7` behind the button) partway through. The button is 6.9:1 once
    the animation ends.
  - The failure reproduced locally with PostgreSQL 17 (3.22:1, a different moment of the
    same fade).
  - Fix: motion is movement only, with no fade, here and in the two dropdowns added by
    this ADR, and the rise is limited to the two entry screens.
  - Retest: the hosted journeys pass 6 of 6, three times in a row, and the viewer suite
    still passes 39 of 39.
- **Retest of a header regression.**
  - Review also found the header wrapping at 1280px (111px instead of 61px).
  - Narrow desktops now get the treatment in Decision 7: the search yields width first, and
    the toggles go icon-only.
  - Measured header heights, before and after:

    | Width | Before | After |
    |---|---|---|
    | 1024px | 111px (two rows) | 61px |
    | 1100px, 1180px | 61px | 61px |
    | 1280px | 61px | 61px |
    | 1440px | 61px | 61px |
- **Entry screens** (Playwright with PerformanceObserver):
  - the card top is at 81px at 1440×900 and 76px at 390×844;
  - layout shift is at most 0.003 and largest paint at most 188 ms (local, software
    rendering);
  - no horizontal scroll at 390px.

- **Inspector length on the demo:** 12,157 → 6,588px at 1440px, and 6,773 → 3,642px at
  1280px. Every finding is still reachable.
- **One test change, kept narrow.** The browser-only opening test still requires that
  nothing but same-origin GETs of the viewer's own `/assets/` files follow a local pick. It
  now also allows `.woff2`, because the explorer can load a font subset it first uses.
- **Repository checks:**
  - `pnpm verify` passes, with 711 tests;
  - `check-repository-baseline` preserves all three corpus repositories;
  - `pnpm verify:distribution` passes, and the archive carries both font licences under
    `third-party/`.
