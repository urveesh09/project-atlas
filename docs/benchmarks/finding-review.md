# Contextual review: functional evidence and boundaries

Recorded 2026-10-29 on Windows, Node 24.22.0/pnpm 10.34.6. Source base
`e518ecf4f0cdf57562a3aed1db305eb592c79a5b`, with Q2.2 uncommitted. These are development
functional observations, not clean-tree release, reference-device or human acceptance.

## Real producer

The official Ruff 0.17.3 Windows archive is rechecked against SHA-256
`a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813` before extraction.
The [producer check](../../scripts/check-finding-review-producer.mjs) authors three Git
commits with one undefined-name finding. Expected positions were fixed before running
Ruff: `sample.py:7:7` becomes `renamed.py:10:7` through an accepted rename and a
three-line insertion. Ruff reports exactly that one F821 occurrence at each endpoint.

The real producer copies committed blobs, checks their Git hashes, runs isolated Ruff,
imports both reports into one two-frame artifact and creates the contextual review.
The result has one continuing unique-context row. All `.git` file bytes are unchanged;
uncommitted `DO_NOT_READ_WORKTREE` content and configured filesystem-monitor data do
not supply input. Exported review contains neither source nor host paths.
[Sanitized result](finding-review-producer.json). No signature was created.

The Windows check does not physically block networking. The read-only verifier CI
job runs the same authored check inside `unshare --net`, with reviewed Linux Ruff
and no signing permissions. Its exact-head result belongs to the PR checks. Actual
cryptography is the separate authentic GitHub vendor fixture, not the mocked producer
policy tests. A live ATLAS signed historical pair still needs owner activation.

## Expected matches and uncertainty

Independent pure/CLI fixtures cover three-frame ID continuity, rename/severity changes,
duplicates, copy/delete-recreate lineage, changed context, unknown columns, missing/
over-budget source, changed version/profile, partial scope, malformed references/rows,
exclusive output, aliases, wrong repositories and cancellation. A real 70-file/two-frame
fixture crosses the native batch boundary with 140 distinct blobs and retains all
70 continuing IDs. Full-size fixtures retain 4,096 findings per side.

Historical policy tests pin both the scan target and the producer checkout. They
exercise one approved current producer for both scan subjects, wrong-target rejection
before invocation, and unchanged direct-policy equality. These are explicitly mocked
orchestration tests, not live signatures. Stored claims remain declarations.

The browser imports atomically, navigates either frame and uses its appropriate
inspector report. Bad rows or wrong bindings preserve the prior pair. A valid file
claiming verification still receives the unauthenticated warning. New checks include
keyboard file selection, filtering, 320/390 px overflow, accessibility, no uploads,
clear/reload and full-size worker import with progressive row reveal. The production
seven-second worker deadline stays unchanged. Screenshots were visually reviewed.

## Failures and design corrections

- The initial browser journey timed out at its unchanged 30-second deadline. Stage
  records isolated the filter action; a direct named-control assertion then found zero
  matches for `Review evidence`. The wrapping label included option text in label
  matching. An explicit `label`/`htmlFor` association fixes the actual control name.
  The original named-control assertion, keyboard behavior and deadline all remain.
- The initial diagnostic itself awaited text on a missing locator, hiding the exact
  stalled action behind the outer timeout. Diagnostic counts/text collections now
  return immediately, and stage markers identify the action. This does not weaken a
  product assertion or raise a timeout.
- Design review found a source-policy mistake before release: a current workflow can
  scan older Git objects, but its attested checkout is current. Historical review now
  requires a separate explicit target pin plus the producer policy; legacy direct
  source equality is preserved. No report chooses its own trust mode or root.
- Screenshot review found crowded tracking rows under the generic flex list. A scoped
  grid separates state, ID and the two navigation links. Existing report styling and
  city rendering stay unchanged.

[Synthetic 20-process comparison observations](finding-review-capacity.md) are separate
from producer and browser evidence. Final suite/corpus/distribution counts are in the
dated [implementation status](../implementation-status.md) entry. None closes G6/R6,
establishes global issue identity, proves a fix or activates signing/deployment.
