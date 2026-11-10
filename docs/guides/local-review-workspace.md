# Save a local architecture review workspace

This Q4 preparation increment keeps one architecture review and structured local
triage decisions after a terminal session ends. It is not a hosted/private/shared
team service. There are no accounts, notifications, billing or network requests.
Existing architecture CI results are unchanged by every decision in this guide.

## Start with matching evidence

First create a [Q3 architecture review](architecture-review.md). Keep the original
artifact: every workspace command requires it and recomputes the retained report.
Stored hashes are integrity metadata, not authenticated producer or human identity.

```sh
atlas workspace init architecture-review.json --artifact atlas-output --out review-workspace --json
atlas workspace inspect review-workspace --artifact atlas-output --json
```

The output directory must not exist and must be outside the immutable artifact.
It contains `workspace.json`: the normalized source-free report, its canonical
SHA-256, a content-derived workspace ID, a revision, and at most 2,000 decisions.
No absolute artifact path is stored, so the workspace and artifact can be moved.
The workspace retains both selected commit/snapshot identities through the report.

The report is scoped to one analysis and policy. Copies or new analyses do not
acquire universal issue identity. A new report gets a new workspace; decisions are
not guessed or carried to a changed report. This increment does not merge forks or
provide a distributed/compliance audit trail. Only each issue's latest decision is
stored, with its last changed revision.

## Record an explicit decision

`inspect --json` lists all retained issue IDs with local state/queue and the current
revision. Human output shows the first 20; use the original report to inspect the
source locations and evidence. Copy the complete `ar_...` ID, never a shortened ID.

```sh
atlas workspace decide review-workspace --artifact atlas-output --issue FULL_AR_ID --state acknowledged --owner architecture-review --expected-revision 0 --json
```

| Field | Allowed values |
|---|---|
| State | `needs-review`, `acknowledged`, `deferred` |
| Ownership queue | `unassigned`, `maintainers`, `architecture-review`, `security-review` |

The owner defaults to `unassigned`. Queue labels are local declarations: no person
is authenticated, assigned or notified. Missing decisions read as `needs-review` /
`unassigned`. No free-text notes, source, secrets, emails or URLs are accepted.
There is no automatic or human-marked `resolved`, clean/security verdict or policy
exception. An acknowledged violation still blocks `review-architecture --fail-on all`.

Each edit requires the revision just inspected. A stale/busy edit fails instead of
overwriting another decision. Inspect again and make a deliberate new edit; there
is no force or automatic retry. Each decision binds its retained issue ID to the
exact canonical report digest. Evidence omitted by Q3's row cap cannot be triaged
by inventing an ID; those omission counts stay visible.

## Export, restore and retention

```sh
atlas workspace export review-workspace --artifact atlas-output --out review-copy.json --json
atlas workspace import review-copy.json --artifact atlas-output --out restored-workspace --json
```

Export creates a new file outside both the artifact and workspace. Import validates
the complete report again and creates a new workspace directory with the same
content identity and revision. Existing destinations are never overwritten. Export
retains the current report and decisions, not past versions or the analyzed artifact.
You must separately retain the matching artifact to reopen/revalidate the workspace.
To inspect the decisions alongside the affected files, open the export from the
[city's Architecture review panel](architecture-city.md#inspect-saved-workspace-decisions).
The browser shows a read-only copy and recomputes the report against the artifact.

There is no expiry or background deletion. Keep/delete the directory and exported
files using your OS's normal private-file controls. Removing an original does not
revoke copies already exported or shared. Repository paths, architecture and metrics
remain sensitive metadata even though source/snippets/messages are excluded.
Do not publish them without reviewing that disclosure.

## Filesystem and failure behavior

- New workspace directories use mode 0700 and files use 0600 on POSIX. Existing
  workspace state must exclude other-user permissions. Windows ACL access is not
  validated by POSIX mode bits; choose a private local directory and review its ACLs.
- Symlink/junction path components, hard-linked state, Windows alternate streams, nonregular/oversized files,
  invalid UTF-8, unknown fields, ambiguous JSON and inconsistent bindings fail.
  Workspace JSON is limited to 10 MiB, its report to Q3's 8 MiB, and revisions to
  1,000,000. No source/config/plugin/repository code is executed or installed.
- Updates use an exclusive `.atlas-review.lock`, descriptor reads, required revision
  and byte/inode comparison, an exclusive synced temporary file and atomic rename.
  Validation/write/compare failures before rename keep the previous committed state.
  Readers see a complete old or new file; this does not promise power-loss durability
  on every OS/filesystem or protect against a local administrator editing all data.
- If interrupted, a lock or temporary file can remain. Never delete a lock while a
  writer may still be running. Stop/confirm all workspace writers first, inspect the
  current revision, then remove only that workspace's stale lock/temporary file with
  your OS tools. The CLI never guesses that a lock is stale or recursively deletes
  a user-selected directory. Interrupted initialization or export may leave an
  incomplete new destination for inspection. Existing destinations are preserved.
- An interruption after atomic rename can leave a completed update even if the
  caller did not receive success. Inspect the revision before retrying.

Exit 0 means the requested local operation completed, **not** that architecture is
clean. Exit 1 reports file/evidence/permission/conflict failure; exit 64 reports
invalid command arguments; exit 130 reports cancellation. The existing Q3 exit 3
belongs only to explicitly requested architecture policy blocking.

Private hosting, shared/authenticated ownership, tenancy, synchronization and paid
plans remain separate Q4 work requiring pilot use and access/retention/cost evidence.
See [ADR-091](../adr/ADR-091-local-review-workspaces.md).
