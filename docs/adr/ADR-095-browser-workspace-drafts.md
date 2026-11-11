# ADR-095: Draft and download workspace decisions in the city

Date: 2026-11-10. Status: accepted for the local review workflow. Extends
ADR-091 and supersedes ADR-094's read-only workspace view for opened exports.

## Evidence and cause

Moving from a city finding to a CLI decision requires copying an opaque issue
ID, entering a revision and re-exporting the workspace. The city already has
the matching artifact and can offer the same structured controls at the row.

## Decision

- Draft changes against an explicitly opened workspace export. Keep one pending
  change per retained issue in memory. Keep the original revision, saved filter,
  and saved decision visible while distinguishing the draft from the saved state.
- Preparing a copy sends the bounded draft and original workspace to the
  existing worker. Revalidate the workspace, recompute the evidence against its
  artifact and apply changes in issue-ID order. Each changed issue advances one
  revision, using the same decision rules as the CLI. A prepared copy uses the
  existing workspace JSON format and a browser-local download URL.
- The reviewer clicks the download link explicitly. Preparing or downloading
  a copy does not write the original, change the browser's saved state, or
  replace an existing CLI workspace. The CLI can import it into a new directory
  and recomputes the report. Independent copies can diverge.
- A failed import or export preserves drafts. New valid input, clear, reload,
  and artifact replacement discard the draft and invalidate the prepared link.
  Draft edits and discard invalidate a previously prepared link. Avoid storage,
  network transfer and changes to policy or artifact identities.

## Verification

Exercise a real CLI export through browser edit, download and CLI re-import.
Check invalid draft bindings, repeatable bytes, revision order, keyboard access,
narrow layout, link invalidation, and preservation of policy findings. Verify
the relocated package and existing matrix. G6 remains open.
