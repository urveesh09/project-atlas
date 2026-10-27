# ADR-074: Private backups and a quarantined, isolated restore drill

Date: 2026-10-18. Status: accepted for production-plan M4.3, merged in [PR #41](https://github.com/urveesh09/project-atlas/pull/41) on 2026-10-18.
Builds on [ADR-072](ADR-072-reference-hosted-deployment.md) and
[ADR-073](ADR-073-operator-monitoring.md). No analyzer, artifact, application API or
database-schema semantics change.

## Evidence and cause

The operations guide required daily custom-format backups kept for seven days but
shipped no scheduler. The existing operator rehearsal restored a dump and counted
revoked rows; it did not run cleanup or prove each restored publication stayed denied.

Two assumptions need correction. First, reconciliation against the real bucket could
delete uploads created after the backup. Second, a snapshot cannot remember a later
deletion or cancellation. Preserving only flags present at backup time does not prevent
restoring later-deleted content or resuming cancelled work. We must test both boundaries.

## Decision

1. **Private streaming backups.** A separate uid/gid 10002 reads through a dedicated
   read-only database role with hostname-verified TLS. libpq service and password files
   are systemd credentials; connection strings/passwords never appear in process arguments.
   The accepted service-file subset prohibits plaintext TLS modes, socket hosts,
   multiple sections, duplicate keys and extra options. Native clients are PostgreSQL 17.
   Dumps stream to mode-0600 exclusive partial files in a private owned 0700 directory;
   memory does not grow with dump size. Deadline/output limits bound child processes,
   and failures wait for process exit before removing partials. Warnings fail the dump.
2. **Publish a verified pair.** `pg_restore --list` validates the custom archive; SHA-256
   and byte count go in a small JSON manifest. Files and directory are fsynced, with the
   manifest published last. Restoration rejects incomplete, mismatched or non-custom
   archives. The hash checks integrity, not an untrusted dump's authenticity. Operators
   must control the private directory and use only trusted ATLAS snapshots.
3. **Bounded retention, independent of success.** A daily UTC backup timer and a separate
   hourly prune timer remove exact generated names (including partials) aged ≥7 days.
   Neither traverses symlinks or removes unrelated operator files. Overlapping prunes
   tolerate already-removed files. A live backup lock is never automatically deleted.
   This clarifies the operations guide's former "at most 7 days" wording as an age
   cutoff, rather than promising continuous physical deletion on an offline host.
   Scheduler cadence, downtime and clock correctness limit the erasure guarantee; an
   operator must separately monitor job success, backup age, capacity and retention.
4. **Scratch-only restores.** The drill accepts an archive and maintenance connection,
   creates a random new database, verifies its nonce through both pg and native clients,
   restores transactionally with no owners/grants, and requires matching migrations.
   It accepts no existing destination. Only that created database can be dropped.
   Cleanup uses a new private filesystem store, never inherited live/S3 settings.
5. **Quarantine before cleanup.** Still-active restored publications become revoked;
   nonterminal jobs become cancelled with incremented revision/generation, cleared
   leases and terminal events. Objects expire and lose cache keys; uploads become
   collectable. Original deletion, revocation, expiry and purge evidence stays intact.
   This intentionally makes restored active analyses unavailable too: users regenerate
   them after recovery. A backup cannot reconstruct unknown later takedown policy;
   real recovery requires external operator reconciliation before admitting new jobs.
6. **Use actual operator operations.** The drill calls the same exported `runOps`
   implementation as `atlas-ops sweep` and `reconcile-storage`, loops with bounds and
   progress checks, and requires every publication to fail authorization with 410
   without contacting GitHub. Owned and orphan probe bytes prove real storage cleanup.
   Success and native-restore failure both remove guarded DBs and fresh credentials.
   Sanitized count/hash reports record failures without database contents or identifiers.
7. **No promotion or live-site claim.** No automatic restore over a live database,
   bucket reconciliation, traffic reopening, role recreation, off-host destination,
   alert delivery or production RTO is added. See the explicit recovery procedure and
   boundaries in [production backups](../production-backups.md). R6-06 stays open.

## Verification

The committed [report](../benchmarks/production-backup-restore.md) records the throwaway
TLS PostgreSQL run and its source/image identities. The fixture includes deletion,
publication/repository revocation, expiry during downtime, active data, deletion after
backup and cancellation after backup. It also checks backup-role write denial, bad
credentials, concurrent-lock refusal, archive corruption, native restore failure,
private permissions, retention and untouched live state. CI reruns the same physical
gate and uploads **only** sanitized JSON. Cross-platform unit tests exercise policy,
validation, bounded diagnostics and child termination; POSIX permission/symlink checks
run on Linux/macOS and in the Linux physical gate. The production rehearsal separately
validates systemd syntax without installing host services or host firewall rules.

The first development rehearsal failed because its fixture expected four newly
quarantined rows; the SQL correctly changes three. The already repository-revoked row
is counted among those three, while the already publication-revoked row is unchanged.
The corrected independent expectation is three quarantined rows and seven denials:
one deleted, four revoked, two expired. Failed and successful reports are retained in
ignored scratch; no assertion or product deadline was weakened.

## Primary references

- [PostgreSQL 17 pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html): consistent
  custom-format database snapshots; cluster globals are separate, and dumps are trusted SQL.
- [PostgreSQL 17 pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html): transaction,
  error, ownership and privilege controls.
- [libpq password files](https://www.postgresql.org/docs/17/libpq-pgpass.html): private file
  permissions and escaping; credentials stay out of process arguments.
