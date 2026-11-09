# ADR-091: Local architecture review workspaces

Date: 2026-10-29. Status: accepted for Q4 preparation. The owner's request for
parallel follow-up PRs authorizes a local pilot foundation after Q3 (ADR-089).
This does not complete or activate hosted/private/shared Q4 services.

## Evidence and cause

Q3 exports reproducible architecture evidence, but a reviewer must start triage
again after closing the report. Retaining one validated review and bounded,
explicit decisions is useful without introducing accounts, tenancy or a database.
Arbitrary notes would also introduce source/secrets and moderation into an otherwise
source-free format, so this increment uses a finite vocabulary only.

## Decision

- Add local `atlas workspace init/inspect/decide/export/import` commands. Each requires
  the original matching artifact and recomputes the retained architecture review.
  A stored digest is integrity metadata, never producer authentication or a trust receipt.
- A workspace contains one architecture review, its canonical SHA-256 and up to 2,000
  decisions. Each decision names a retained issue ID and the exact report digest;
  omitted evidence cannot be triaged by guessing an ID. Reusing the report's analysis
  and policy scope avoids claiming permanent issue identity across analyses.
- Decision states are `needs-review`, `acknowledged`, `deferred`. Ownership is an
  operator-selected queue: `unassigned`, `maintainers`, `architecture-review`,
  `security-review`. These labels do not notify or authenticate a person/team. No
  free text, source, emails, URLs, automatic resolved status or policy-gate override.
- Workspace JSON is strict, bounded to 10 MiB, and rejects unknown/duplicate keys,
  invalid digests, duplicate/unknown issues and inconsistent revision/count metadata.
  Canonical bytes and IDs are deterministic; no host paths, timestamps or random IDs
  are stored. Local revision numbers express edits, not an authenticated audit trail.
- Initialize only a new directory outside the artifact. Use mode 0700 directories
  and 0600 files where supported. Reject symlink/junction path components, hard-linked
  state files, Windows alternate data streams and nonregular/oversized state.
  Open once with read-only flags, then validate the descriptor, pathname and
  directory identity before reading. POSIX uses no-follow and nonblocking
  flags. Windows verifies the pathname after opening and before reading bytes.
  Protected-directory ancestry is checked by filesystem identity, including case
  aliases on case-insensitive POSIX filesystems, rather than string prefixes alone.
- Decision updates require an expected revision and a cooperative exclusive lock.
  Read and validate after locking; write/sync an exclusive temporary file; compare
  the current bytes and identity again; atomically rename within the workspace.
  Concurrent/stale changes fail rather than overwrite. Never auto-remove a stale
  lock: an interrupted operator must establish that no writer is running before
  removing it. A local filesystem owner remains the trust boundary; this is not a
  defense against an administrator racing directory renames or editing all hashes.
- Export is exclusive and outside the artifact/workspace; import validates against
  the matching artifact and creates a new private directory. Copies remain readable
  after originals are removed; there is no expiry, background deletion, remote
  revocation or automatic cleanup of user data. Operators control retention and OS
  permissions. Atomic replacement does not promise durability across power loss on
  every filesystem.
- No scanner/repository code executes, no network is used, and artifact/analyzer
  bytes and versions remain unchanged. No dependencies, hosting, auth/tenancy,
  billing, release, deployment or signing activation. Shared/private Q4 requires
  pilot repeat use, access/deletion/retention and cost evidence before billing.

## Verification

Require authored review/decision round trips, tamper and malformed input rejection,
wrong artifact/report/issue bindings, no source/path leakage, symlink/hardlink and
regular-file bounds, optimistic conflict/concurrent writer behavior, atomic failure
preservation and portable export/import. Focused tests and actual observed results
are recorded in the guide/evidence and PR. Full verification, packaging and exact
analyzer corpus checks remain mandatory before commit. G6/R6 remains open.

The initial PR #59 scan flagged [CodeQL alert 75](https://github.com/urveesh09/project-atlas/security/code-scanning/75)
on the read-only stat-before-open sequence. The revised reader opens first
and uses its descriptor for the bounded read. An injected mismatch between
the opened file and requested pathname must close the descriptor with zero
reads. The initial result is retained and the unchanged scan gate reruns.
