# ADR-098: Trace consumer paths in Compare

Date: 2026-11-12. Status: accepted for artifact viewing.

## Evidence and cause

ADR-097 shows imports that changed. A reviewer still has to open several
inspectors to trace who uses a changed file through a re-export or an
intermediate module. A repository-wide traversal for every changed file
would add work to opening Compare and could imply a runtime impact verdict.

## Decision

- Trace incoming, internal file edges for the selected lineage in a single
  snapshot at a time. Default to B when the file exists there and A otherwise.
  Keep the selected path and snapshot explicit, including for renames and
  files absent on one side. Results on each side describe that snapshot's
  recorded graph and coverage.
- Use the same edge policy as static cycles: value imports, value re-exports
  and literal requires. Breadth-first traversal yields one shortest path
  per consumer. At equal depth, sorted UTF-8 repository paths make traversal
  deterministic. Show arrows from the consumer toward the selected file.
- Use the existing worker and reach bounds: default depth 2, maximum depth 5
  and at most 2,000 reached consumers. Return the first 50 paths ordered by
  hop count and path. Distinguish the display limit, visit cap, depth
  boundary and partial snapshot coverage. Compute routes on request. Keep the
  open control during comparison changes and discard results when their
  snapshot, selected file or depth is no longer current.
- Each importer in a path opens its Dependencies inspector in the original
  snapshot. Opening A ends Compare so the inspector and city agree. The
  feature uses validated artifact data and introduces no persisted fields.

## Verification

Check a diamond, a cycle, policy exclusions, deterministic path order,
and both traversal bounds. Use the authored Harbor history to check a
transitive path, a renamed lineage on both sides, and keyboard navigation
to a historical import. Check 320 px reflow, automated accessibility, and
the pinned real-repository baseline.
