# M4.3 backup and restore drill — 2026-10-18

Local implementation evidence; exact-head CI and owner merge remain required.
[Machine-readable report](production-backup-restore.json),
[decision](../adr/ADR-074-private-backups-and-restore-drill.md),
[operator procedure](../production-backups.md).

Host: Windows, Intel i5-10400, 6 physical cores, approximately 16 GiB RAM; Docker Linux
Engine 29.8.1. The tooling uses pinned Node 24.22.0 and PostgreSQL client/server 17.11.
No reference-capacity or production RTO result is inferred from this small fixture.

The report honestly records base `45743e1882d4243720e572888e2645ce498f0b0a`,
`dirty: true`, immutable tooling/server images and SHA-256s of the scripts,
service units and configuration examples tested. This is a development-tree functional
run, not a clean release-candidate measurement. CI rebuilds/repeats it at the PR head.

## Results

All **10 steps passed**; owned containers, internal network and Linux volumes removed.
No ports were published, no live secrets were supplied and no live bucket was used.

| Check | Observed result |
|---|---|
| Verified TLS and current migrations | Native and Node clients reached the same scratch DB, checked by nonce |
| Dedicated read-only backup role | Both `DELETE` and `CREATE TABLE` denied with PostgreSQL 42501 |
| Streaming custom backup | Complete dump/manifest pair, validated SHA-256, private directory/file permissions |
| Bad credentials, mismatched TLS hostname and concurrent backup lock | All refused; no partial or extra ready pair left |
| Post-backup lifecycle changes | Source deletion/cancellation made after capture; one publication expired during the wait |
| Restore and real cleanup | Three formerly active rows quarantined, one queued job cancelled/fenced; actual `runOps` sweep and reconcile called |
| Access control | All seven publications denied: one deleted, four revoked, two expired; no GitHub request |
| Storage isolation | Restored owned upload probe and orphan prefix removed; original live-storage marker survived |
| Corruption/native failure | Hash corruption rejected before DB creation; invalid native archive failed and its scratch DB/credentials were removed |
| Retention | Old dump, manifest and partial removed at seven days; usable backup and unrelated operator note preserved |

Original non-null deleted/revoked/purged timestamps and all publication expiry timestamps
were compared before/after cleanup. The repository-revoked timestamp was also unchanged.
The live source retained its later deletion/cancellation and had no newly purged rows.

Additional local checks:

- `pnpm verify` with required Chromium journeys: **875 passed, 84 skipped** on Windows
  (service-gated tests and the POSIX-only permission/symlink unit case are disclosed skips).
- Six-repository baseline guard: exact committed payload/source expectations preserved.
- Existing production profile rehearsal: **16/16**, including syntax validation of all
  new systemd units. It does not boot systemd or apply host firewall rules.

## Retained failures and limitations

The first development rehearsal failed at its restore assertion because the fixture
expected four newly quarantined rows instead of three. The script's lifecycle result was
correct; the expectation was corrected to account for the already publication-revoked
row. The failed report is retained in ignored `.atlas-tmp/m43-first.json`; the next run
passed, followed by the final run with expanded failure/cleanup checks. No product gate
or assertion was weakened.

This does not prove off-host retention, encrypted-volume provisioning, a working live
timer, delivery of alerts, a production recovery time, or recovery of decisions made
after a snapshot. Restored active state is deliberately denied. Reopening admission
requires operator reconciliation of external takedown/security records. **R6-06 and
G6 remain open.**
