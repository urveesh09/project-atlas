# ADR-055: 3D-print export (3MF with colours, STL)

Date: 2026-10-14. Status: accepted. Catch-up item 7 of [ADR-048](ADR-048-editions-and-free-parity.md).
Changes no contract, artifact byte or analyzer version.

## Evidence and cause

CodeCharta exports a 3D-print model of its maps. A printed city is a tangible artefact for
team walls, onboarding and talks, and ATLAS had no way to make one.

## Decision

1. **Two formats in the Share menu.**
   - *3D print, coloured (3MF)* keeps each building's colour on screen: lens bands, custom
     bands (ADR-052) or change colouring (ADR-050).
   - *3D print (STL)* is the universal single-colour format.
   - Both export the city shown, with the scope applied (ADR-051).
2. **Only data becomes geometry.** The model contains:
   - a 2 mm base plate;
   - one plinth per nested district, 0.6 mm per depth;
   - one box per file, centred on its plot at 70 % of the plot, standing on its district's
     plinth.

   A box's height is the city's own height (code lines, on its logarithmic scale), with a
   0.4 mm printable minimum. Decorative parts are left out: roofs, windows, trees,
   harbour.
3. **Scale and units.**
   - Millimetres; the longer side of the city is 150 mm.
   - Height keeps the on-screen proportions; there is no vertical exaggeration.
   - The export message states the base size and the height.
4. **Format details.**
   - Every solid is a closed box with outward-facing triangles.
   - 3MF is a store-only ZIP with CRC-32s, built in the browser without a library. It
     holds content types, relationships and one model part.
   - Each box is its own object. Its colour is set on the object and repeated on every
     triangle, because more readers honour the per-triangle form.
   - The model title carries the repository, commit, colouring and analyzer.
   - At most 250,000 solids.

## Verification

- `apps/web/test/print3d.test.ts` covers:
  - placement of the base, plinth and boxes, and the proportions;
  - the minimum height;
  - every STL triangle's winding agreeing with its normal (outward);
  - all vertices inside the stated bounds;
  - a store-only unzip that checks every signature and CRC-32;
  - XML escaping of the title;
  - object, item, triangle and colour counts;
  - the solid limit.
- The browser end-to-end test *exports the city for 3D printing* downloads both files and
  checks:
  - the ZIP signature and model part;
  - the STL size equals 84 + 50 bytes per triangle;
  - 12 triangles per solid, and more solids than buildings.

  The suite passes 38 of 38.
- Independent readers, on the vuejs/core demo exported in the code-lines lens:
  - **trimesh 5.1.1:** both files load as 804 closed shells (base, 101 plinths, 702
    buildings), each with positive volume, so outward-facing; 105 × 150 × 13.8 mm.
  - **lib3mf 2.5.0** (the 3MF Consortium's reference library), in strict mode: no
    warnings; 804 mesh objects and 804 build items; one material group of 10 colours;
    all 9,648 triangles coloured.
