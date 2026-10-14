# ADR-054: Package dependency view

Date: 2026-10-14. Status: accepted. Catch-up item 5 of [ADR-048](ADR-048-editions-and-free-parity.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

- **The gap.** CodeCharta has an experimental dependency view. ATLAS showed dependencies
  file by file, as city strokes and inspector lists, but not how packages depend on one
  another.
- **Where it matters most.** Architecture questions in a monorepo are usually asked about
  packages: which packages are in a cycle, and which sit at the bottom.
- **The data existed.** `GraphIndex.packageRollups` already rolls file edges up to package
  pairs, with unique file pairs, observation counts and kinds.

## Decision

1. **A fourth view, *Package graph*.** It is listed in the View select and accepted in URL
   fragments and saved views as `mode=packages`.
2. **Layout** (`apps/web/src/app/package-graph.ts`, pure and deterministic):
   - packages in a dependency cycle form one strongly connected component (iterative
     Tarjan);
   - components are layered by the longest path to a package with no dependencies;
   - every edge between components points down, drawn from the bottom of the dependent to
     the top of its dependency;
   - edges inside a component close a cycle: they are dashed, red and named in the table;
   - a layer wider than six packages wraps onto further rows, so a large cycle stays
     readable, and every row of a layer sits above every row below it;
   - order within a row comes from four barycentre sweeps with a name tie-break.
3. **What a box and an edge say.**
   - A box shows the package's file count and its internal file pairs.
   - Edge width grows with the logarithm of the file pairs, capped.
   - Hovering or selecting a package dims everything not connected to it.
4. **Accessible and complete.**
   - Boxes are keyboard buttons that select their package.
   - The diagram is a focusable, labelled scroll region.
   - A table carries every edge: from, to, file pairs, import statements, kinds, and
     whether it closes a cycle. It shows at most 200 rows, with the total stated.
   - The cycles are listed by name.
   - Above 400 packages only the table is shown, and the view says so.
5. **The policy is shared with the city.** *Include type-only imports* is the same setting
   as the city's overlay. Package graphs follow the snapshot shown, so history and
   comparison apply.

## Verification

- `apps/web/test/package-graph.test.ts` covers:
  - layering, internal pairs, cycle detection, and edges that close a cycle, on a named
    example;
  - 150 random graphs of up to 40 packages. Every non-cycle edge points from a higher
    layer to a lower one and is drawn downward. Every cycle edge stays inside one
    component. Boxes in a row never overlap and stay inside the canvas. Rows hold at most
    six boxes. Shuffled input gives an identical result.
- The browser end-to-end test *draws the package dependency graph* covers:
  - box, edge and table counts match the summary;
  - Enter on a box selects the package;
  - including type-only imports can only add dependencies;
  - an axe audit passes.

  The suite passes 37 of 37.
- vuejs/core demo: 18 packages, 57 dependencies between packages and 3 layers. One cycle
  of 11 packages, now named for the first time, wraps onto two rows. No horizontal page
  overflow at 390 px; the diagram scrolls inside its region.
