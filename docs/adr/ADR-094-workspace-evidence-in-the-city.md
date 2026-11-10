# ADR-094: Read local workspace evidence in the city

Date: 2026-11-10. Status: accepted for the local review workflow. Extends
[ADR-090](ADR-090-architecture-review-in-the-city.md) and [ADR-091](ADR-091-local-review-workspaces.md).

## Evidence and cause

The city can show a recomputed architecture report. The local CLI can save
triage decisions for that report. A reviewer currently loses those decisions
when moving from the CLI to the city, where the affected files are easier to
inspect.

## Decision

- The existing Architecture review panel opens either a plain report or an
  explicitly picked local workspace export. A report is limited to 8 MiB and
  a workspace to 10 MiB. Keep the existing worker, creator-channel check and
  20-second query deadline.
- Parse and check the workspace with the CLI's existing strict validator.
  Recompute its embedded architecture report against the matching artifact,
  analysis and ordered snapshots. Only the recomputed evidence and bounded
  decision metadata reach the panel. Reject failed imports without replacing
  the last accepted evidence.
- Show the workspace revision, recorded decision count, queues and a separate
  decision filter. Keep evidence states, coverage and policy counts independent
  of triage. Distinguish a row without a saved decision from one explicitly
  marked Needs review. Decisions are local declarations without actor or
  producer authentication.
- Keep the browser copy read-only and in memory. Clear, reload, or open another
  artifact to discard it. To edit decisions, use the CLI and export a new copy.
  This increment adds no server, storage, execution or policy gate.

## Verification

Exercise the CLI-export-to-browser flow, corrupt and unrelated inputs, keyboard
use, 320 px reflow, filtering and current/baseline navigation. Preserve analyzer
bytes and check the relocated CLI and full browser matrix. Human and device
acceptance stays in G6.
