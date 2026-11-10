# Inspect architecture evidence in the city

Create a JSON report with [`atlas review-architecture`](architecture-review.md).
Keep the original analysis folder. The report binds to the analysis and to its
current and optional earlier baseline snapshots.

1. Open the matching artifact with `atlas serve` or the viewer's folder picker.
2. Choose **Architecture review** in the toolbar, then **Open architecture review JSON…**.
3. Check the coverage, rule counts and omitted rows. Filter by rule or evidence state
   and use **Show 20 more** to reveal additional retained rows.
4. Choose **Current file** or **Baseline file** to select that occurrence in the
   city and open its Dependencies inspector. The baseline link uses the earlier
   path when the file was renamed. Expand a cycle's witness to see its directed
   relationships and available statement positions.

The browser recomputes the policy and report in its background worker from the
validated artifact frames. It refuses mismatched or changed evidence and keeps
the last accepted report when an import fails. The file limit is 8 MiB. Reports
stay in memory. Clear the panel, open another artifact or reload to discard them.
The same controls work in the table view.

## Inspect saved workspace decisions

If you already have a [local review workspace](local-review-workspace.md), run
`atlas workspace export` and keep the matching analysis folder. Open that folder
in the viewer, then choose **Architecture review** → **Open workspace export…**
and select the exported JSON. The export limit is 10 MiB.

The panel shows the saved revision and queue for each recorded decision. Use
**Workspace decision** together with the rule and evidence-state filters to
find acknowledged, deferred, needs-review or unrecorded rows. An explicit
Needs review decision and a row without a saved decision are separate choices.

The browser recomputes the underlying report before showing the decisions.
Queues are local declarations and leave policy counts and CI results intact.
Use `atlas workspace decide` to make edits, then export and reopen a fresh copy.
Opening a plain report replaces the workspace view. Clear, reload or open
another artifact to discard the browser copy. See [ADR-094](../adr/ADR-094-workspace-evidence-in-the-city.md).

Counts describe observed internal file dependencies. Unmatched selectors, incomplete
coverage and capped evidence are shown separately. A cycle row compares the member
set of a static component, so a continuing component can gain new internal routes.
A matching report does not authenticate its producer or establish runtime impact,
security, resolution or merge approval. See [ADR-090](../adr/ADR-090-architecture-review-in-the-city.md).
