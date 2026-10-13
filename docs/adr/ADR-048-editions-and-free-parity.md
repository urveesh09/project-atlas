# ADR-048: Editions, free parity, highlight and saved views

Date: 2026-10-13. Status: accepted. Builds on [ADR-044](ADR-044-release-engineering-and-pilot-readiness.md)
and [ADR-047](ADR-047-beta-2-activation-workspace-and-release-identity.md). Changes no
contract, artifact byte or analyzer version.

## Evidence and cause

- **The assessment.** An external Beta 1 assessment recommended keeping the analyzer, CLI,
  artifact format and viewer open source, and selling team continuity later. It also named
  CodeCharta as a free alternative.
- **The owner's direction (2026-10-13).** Billing waits. First the product must become good
  enough to leave beta. The free edition must offer at least as much as the free
  alternative, and the paid edition more.
- **CodeCharta.** Its documentation says it is free and MIT-licensed; its maker sells
  consulting. Its visualization documentation describes:
  - custom scenarios with import/export;
  - glob search that greys out misses;
  - flatten and exclude rules;
  - per-band counts on the colour metric;
  - screenshot to clipboard;
  - metric choice for area, height and colour;
  - five layouts, delta mode, folder colours and 3D print.
- **Where ATLAS stood.** It had none of the first five. Its strengths lay elsewhere:
  evidence, stable history, safety and accessibility.

## Decision

1. **Editions.**
   - Everything ATLAS ships today stays free under MIT: analyzer, CLI, artifact format and
     viewer.
   - A future paid *Team* edition adds hosted continuity and collaboration that cost money
     to run: private workspaces, retained baselines, scheduled refresh, shared views and
     annotations, and support.
   - **No free feature is ever moved to the paid edition.**
   - Billing, accounts and tenancy are not built until pilots show repeated team use.
     Commercial hosting cannot use GitHub Pages, whose terms exclude commercial SaaS.
2. **Free parity is tracked in the open.**
   [docs/product/editions-and-comparison.md](../product/editions-and-comparison.md)
   compares the free editions feature by feature, with ◐ and — where ATLAS is behind.
   It also lists the catch-up work in order. Each item needs its own ADR before it ships.
3. **This change closes five gaps.**
   - **Highlight by path pattern**, in the `.gitignore` style:
     - commas or new lines separate patterns, and `!` excludes;
     - `*` and `?` stay within a segment, and `**` spans segments;
     - a name without `/` matches any segment; a pattern with `/` is anchored and covers a
       folder prefix; a trailing `/` matches folders only.

     Misses are dimmed in 3D and on the map, and dropped from the table. A note gives the
     exact count of matches. Matching runs over a bounded segment table, so a pasted
     pattern cannot backtrack. Input is limited to 32 patterns of 256 characters each.
   - **Saved views.**
     - A view stores the lens, view, display filter, dependency options, highlight,
       selected path, style and camera.
     - Views are kept per repository in this browser, at most 100. *Export views*
       downloads `atlas.views/1` JSON, and *Import views…* merges a teammate's file by
       name.
     - Imported files are untrusted. Every field is checked against an allowlist or a
       bound, and invalid entries are skipped and counted. Paths only select; nothing is
       executed or fetched.
     - A 3D camera is restored only in 3D, and a map camera only on the map.
   - **Per-band counts** on the legend, from the same banding as the facade colours, with
     the count of unknowns.
   - **Copy image** puts the PNG on the clipboard where the browser allows it. The message
     points to *Export PNG* for a copy that keeps its provenance.
   - **A Share menu** holds Copy image, Export PNG and Export metadata, so the toolbar
     keeps two short rows on a laptop.

## Verification

- `apps/web/test/path-pattern.test.ts` checks:
  - names, anchors, folder-only rules, globstars, include and exclude combinations;
  - the limits;
  - that a hostile pattern runs 50 times on a 2,000-character path in under 2 s.
- `apps/web/test/saved-views.test.ts` checks:
  - a round trip through an exported file;
  - eight hostile entries: six skipped, and unsafe fields in the kept ones nulled;
  - merge by name, newest first, with a cap of 100.
- Browser end-to-end tests, in the suite *guided start and workspace*:
  - a highlight count equals the table's count, and every row matches;
  - an oversized pattern is reported;
  - fan-in band counts sum to the matched files;
  - a view is saved, the settings changed, and the view restored, including the table
    view and the highlight;
  - exported, deleted, re-imported and audited with axe.
- The demo build keeps its first-screen measurements from ADR-047: the stage starts at
  y = 408 at 1366×768 and y = 429 at 390 px, with no horizontal overflow at 320 px.
