# ADR-051: Scope: focus on a folder, hide paths

Date: 2026-10-14. Status: accepted. Catch-up item 2 of [ADR-048](ADR-048-editions-and-free-parity.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

CodeCharta offers flatten and exclude rules and focus on a folder. ATLAS could only *dim*:
the display filter and the highlight (ADR-048) kept every building drawn. A team studying
one package, or wanting generated output out of the picture, had no way to remove it.

## Decision

1. **A *Scope* menu** holds two controls:
   - **Focus** keeps one folder or package. It is chosen with *Focus* on the selection card
     of any folder or package.
   - **Hide paths** takes patterns in the highlight syntax of ADR-048. *Hide* on a card
     adds that folder as an anchored pattern, `/path`. At least one pattern without `!` is
     needed; a list of exceptions alone hides nothing.
2. **Plots never move.** Hidden files are left out of the city data passed to the
   renderers, so their plots stay empty and the layout does not reflow. A scoped city still
   lines up with every snapshot, comparison and saved camera. District grounds and package
   labels stay for orientation.
3. **Hiding is not deletion.** Scope changes only what is drawn. Analysis results, the
   inspector, search and findings still cover the whole repository. Every count says what
   is shown and what is hidden:
   - the menu summary;
   - the table caption ("N hidden by the scope");
   - the highlight note.

   A hidden file that is selected says so on its card and offers *Show everything*.
4. **Dependent views follow the scope.**
   - Dependency strokes to a hidden file are dropped and added to the omitted count.
   - Compare ghosts and markers on hidden paths are not drawn.
   - Legend band counts and change colouring (ADR-050) count shown files only.
5. **Saved views store the scope.** The fields are `focus` and `hide`, validated and
   bounded like the highlight. Views saved before this read as showing everything. Exports
   record the scope in their metadata (`scope`).

## Verification

- `apps/web/test/scope.test.ts` covers:
  - focus without catching look-alike siblings (`packages/core` against
    `packages/core-extra`);
  - anchored and unanchored hiding;
  - `!` exceptions, and exceptions alone hiding nothing;
  - the limits.
- `saved-views.test.ts`: older views read as unscoped, and scope fields are bounded.
- The browser end-to-end test *focuses on a folder and hides paths*:
  - the table shows only the focused folder;
  - the caption and the menu both name the hidden count;
  - hiding `*.test.ts, *.spec.ts` removes them;
  - an axe audit passes with the menu open;
  - *Show everything* restores the total.

  The suite passes 34 of 34.
- The vuejs/core demo, focused on `@vue/runtime-core`: the renderer reports 116 of 702
  buildings drawn, and every other plot is empty.
