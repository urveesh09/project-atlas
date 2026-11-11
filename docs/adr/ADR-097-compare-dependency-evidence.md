# ADR-097: Inspect dependency changes in their original snapshots

Date: 2026-11-11. Status: accepted for local and hosted artifact viewing.

## Evidence and cause

Compare lists added and removed dependency edges. A reviewer currently has to
leave the list and find the matching import manually. The comparison already
holds validated models of both snapshots and identifies file edges by lineage
and relationship kind.

## Decision

- Show evidence in the dependency change row. Resolve added edges in B and
  removed edges in A, including when A and B are swapped. Use the existing
  projected identity and the original edge's retained observation IDs.
- Open one row at a time and display up to eight retained observations. Show
  statement counts and distinguish the display limit from positions omitted
  by the artifact. The source button opens Dependencies for that file in the
  evidence snapshot. Opening A closes Compare and moves keyboard focus to the
  inspector after navigation.
- Offer a filter for the selected file. Match both ends by lineage so an
  incoming edge survives a rename and a selected file missing from B can still
  match removals. Keep repository-wide comparison totals visible.
- The rows describe differences between observed static relationships. A
  resolution or coverage change can affect the list. The viewer uses the
  existing frame cache and computes evidence for the open row from its index.

## Verification

Exercise exact edge lookup, renamed endpoints, external targets, omitted
positions, forward and reverse comparison, selected-file filtering, and
keyboard navigation on an authored history fixture. Run the existing viewer
matrix, distribution checks and repository baseline guard.
