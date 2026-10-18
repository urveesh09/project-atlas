# ADR-078: Job-record retention and the status channel

Date: 2026-10-18. Status: proposed; exact-head CI and owner merge required. Decided by
the agent under the owner's explicit delegation (2026-10-18: "how long to keep the
records up to you … for the 3rd point also you can decide"). Builds on
[ADR-077](ADR-077-public-service-pages.md) and [ADR-076](ADR-076-service-levels.md).
Adds migration 3 and one capability limit; artifact bytes and versions are unchanged.

## Evidence and cause

- **Records were kept forever.** Checking ADR-077's privacy facts against the code found
  that job records are never deleted. Each holds the submitted repository URL, and its
  repository row holds the canonical name and numeric ID.
  - Publications expire after 7 days, and the purge already deletes their stored
    artifacts.
  - But the database rows (job, events, admission, checkpoint, publication, artifact
    object and upload) stayed indefinitely.
- **Taken-down repositories must be remembered.** A revoked repository's `revoked_at` is
  what refuses later publications of it (`ARTIFACT_REVOKED`). Deleting that row would undo
  a takedown.
- **The worker's privileges are deliberately narrow.** `control.test.ts` asserts that the
  worker role cannot `DELETE FROM jobs` or read admissions. A retention sweep with plain
  `DELETE` grants would weaken that.
- **Cache reuse shares artifacts.** A reused analysis points a new publication at
  another job's artifact. Foreign keys tie publications to artifact objects, artifact
  objects to uploads, and uploads to jobs.
- **There was no status channel.** [Service levels](../hosted-slo.md) asked the owner to
  name one, and the service had none.

## Decision

1. **30 days.** `LIMITS.jobRecordRetentionDays` = 30, after the job's last update in an
   ended state.
   - That is longer than the 7-day publications and 7-day backups, so a deleted record
     leaves the last backup within 37 days.
   - It is long enough to investigate an incident or abuse within the service levels'
     30-day window.
   - The viewer's privacy facts read the same limit.
2. **What may be deleted.** A job is forgotten only when it has ended, is past retention,
   its publication (if any) is purged, every one of its uploads is purged from storage,
   and no other job's publication refers to an artifact it stored.
   - It is deleted with its events, admission, checkpoint, publication, artifact object and
     upload rows, in foreign-key order.
   - Its repository row goes too when nothing else refers to it, unless taken down.
3. **Least privilege, by a function.** Migration 3 creates
   `atlas_forget_ended_jobs(batch)`:
   - `SECURITY DEFINER`, owned by the schema owner, with `search_path` fixed to the owning
     schema and `pg_temp` last;
   - the retention period is part of its definition, and batches are 1–1000;
   - `EXECUTE` is revoked from `PUBLIC` and granted only to the worker role
     (`ROLE_FUNCTIONS`).

   The worker still has no `DELETE` on jobs, publications or admissions. A compromised
   worker can do no more than run the policy early, and that changes nothing before the
   records are 30 days old.
4. **When it runs.** Hourly in the worker service, logging only counts, and on demand with
   `atlas-ops forget`.
5. **The status channel.** `ATLAS_STATUS_URL` is a plain `https:` URL, required outside
   development like the contact.
   - It is in `LegalNotices` and linked from every hosted page as "Service status".
   - The default is the project's GitHub issues labelled `incident`. GitHub serves it, so
     it stays reachable when the service is not. It is public, people can follow it, and it
     costs nothing.
   - Incident issues state severity, impact and the next update time, and close with the
     summary.
6. **Legal texts stay as placeholders** until the owner supplies them. A production API
   keeps refusing them.

## Not decided here

- Any legal wording. The privacy facts describe this behaviour; whether it meets any
  obligation is the owner's call.
- Creating the GitHub `incident` label. It is made when the first incident is filed.

## Verification

- **PostgreSQL** (pinned image, throwaway container), `retention.test.ts`, 5 tests:
  - forgets a job past retention with everything it owned, and its repository;
  - keeps a job inside retention, an unfinished job, a live publication, and an upload still
    purging;
  - keeps a reused artifact until the reusing job is forgotten first;
  - keeps a taken-down repository with its revocation;
  - the worker role can run the function but still cannot `DELETE FROM jobs` or read
    admissions, the API role cannot run it, and the batch bound is enforced.
- **Mutation checks:** removing the storage-purged condition, the reuse condition or the
  takedown exception each fails exactly one test.
- **Existing PostgreSQL suites:** control, queue and hosted API pass, 52 tests. Two test
  role cleanups now also revoke function privileges, which `DROP ROLE` needs. That was the
  only failure found.
- **Status URL:** unit tests for the loader (required; four non-`https:` values refused),
  the viewer link guard, and the preflight; the hosted journey checks the "Service
  status" link; the production rehearsal checks `/api/v1/legal` returns it.
