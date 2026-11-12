# ADR-100: Reference city models by name

Date: 2026-11-12. Status: accepted for the viewer.

## Evidence and cause

Each city style has a model catalog, district families, and a smaller pool for
low buildings. Families and low pools used array positions to identify
archetypes. Inserting a model could silently redirect those positions.
The separate family and window arrays also depended on matching positions.

## Decision

- Write model names in the district and low pools. Put the window patterns
  beside the model choices they apply to. Require nonempty pools and known
  model names at typecheck, and reject duplicate names when defining a theme.
- Resolve names once when the theme is defined. The renderer still uses
  numeric indices for its instanced body batches. Preserve model order,
  every pool order, and seeded selection during migration.
- Keep the [city model guide](../guides/city-models.md) as the place to look up
  built-in models, geometry, shaders, surroundings, and the preview workflow.

## Verification

Compare compiled definitions with the pre-migration themes, exercise
reordering and model validation, and run the existing geometry, rendering
and browser journeys. Verify the pinned artifact baseline.
