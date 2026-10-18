# Production backups and restore drills

M4.3 reference kit, [ADR-074](adr/ADR-074-private-backups-and-restore-drill.md).
These are private **control-plane database** backups. They contain operational metadata,
including repository references and management capability hashes; do not publish them or
upload them as CI artifacts. No artifact-bucket backup is needed. Repository analyses are
reproducible. This kit does not deploy anything to a live site.

## Provision on the database operator host

Use PostgreSQL 17 clients, the pinned Node 24 toolchain, an encrypted backup filesystem,
and a reviewed site copy of the configuration. The reference tools image is for rehearsal;
the systemd units invoke the installed host tools directly. No Docker socket is required.

1. Reserve uid/gid **10002** for `atlas-backup`; do not reuse the worker's 10001.
   Install Node at `/opt/atlas/node/bin/node`, PostgreSQL clients in
   `/usr/lib/postgresql/17/bin`, and the reviewed scripts from
   [deploy/production](../deploy/production/) at `/opt/atlas/production/` (root-owned,
   not writable by the service). Copy `backup.mjs` and `restore-drill.mjs` together.
2. As the ATLAS schema owner, review and apply [backup-role.sql](../deploy/production/backup-role.sql)
   in the ATLAS database. It creates a read-only role with no login initially. Set its
   password privately using psql's `\password atlas_backup`, then enable `LOGIN`.
   Default grants apply to objects created by that schema owner; repeat for another
   migration owner if the site uses one. Restrict the login to the backup host using
   `pg_hba.conf` with `hostssl` and SCRAM authentication. Do not grant superuser,
   write privileges, `CREATEDB` or replication access to the backup role.
3. Create root-owned `/etc/atlas/backup/` mode 0700. Adapt
   [pg_service.conf.example](../deploy/production/pg_service.conf.example) and
   [pgpass.example](../deploy/production/pgpass.example) into `pg_service.conf` and
   `pgpass` there, both root-owned mode 0600. The service uses systemd credentials to
   make private copies available to uid 10002. Never place credentials in a unit,
   command argument, shell history or Git. Escape `:` and `\` in pgpass fields.
4. Install the database's public trust certificate at `/etc/atlas/backup-ca.crt`,
   root-owned mode 0444. It contains no private key. `sslmode=verify-full` is mandatory:
   use the DNS name on the server certificate. The service parser accepts only one
   `[atlas_backup]` section with `host`, `port`, `dbname`, `user`, `sslmode`, `sslrootcert`
   and optional `sslcert`/`sslkey`. Values are unquoted without whitespace. For mutual
   TLS, provision the private key readable only by uid 10002, outside `/home` and `/tmp`.
5. Place the four `atlas-backup*.service` / `atlas-backup*.timer` files in
   `/etc/systemd/system/`, root-owned mode 0644. systemd creates
   `/var/lib/atlas/backups` owned by 10002, mode 0700. Review that the encrypted mount
   is present before enabling the timers. Run `systemd-analyze verify` on the site copy,
   `systemctl daemon-reload`, then start `atlas-backup.service` once and inspect its
   exit status and private archive pair before enabling both timers.

```sh
systemctl enable --now atlas-backup.timer atlas-backup-prune.timer
systemctl list-timers 'atlas-backup*'
journalctl -u atlas-backup.service -u atlas-backup-prune.service
```

The daily timer runs at **02:00 UTC**, with catch-up after downtime. The independent
hourly pruner also catches up; failed backups do not suspend retention. Each successful
backup streams `pg_dump -Fc` to a mode-0600 partial file, validates it using
`pg_restore --list`, fsyncs it, hashes it, and publishes a dump + JSON manifest pair.
The manifest is renamed last. Use only complete matching pairs. No database rows,
names, paths or connection strings are printed; journald gets count-only completion or
a generic failure. A dump warning fails the backup instead of silently publishing it.

Pruning removes only this tool's exact archive names, including abandoned partials,
at age **≥7 days from the UTC start timestamp** in their names. A running host's
hourly cadence normally leaves a file for roughly one extra hour at most, plus timer
accuracy and scheduling delay; a powered-off host cannot
prune. Do not describe this as a hard continuous seven-day erasure guarantee. Off-host
copies require their own encryption, access control and the same deletion schedule;
no off-host destination or long-term storage is configured by this kit.

## Failure handling

Check the service exit status, newest complete manifest time and filesystem free space.
An independent operator monitor must alert on failure or a missing daily backup; wiring
that alert to a real on-call destination remains site-specific R6-06 work. Nominal
recovery point is one day; missed jobs increase it. This fixture drill does not establish
production RTO or capacity. Never treat a partial or hash-mismatched archive as usable.

The backup lock prevents concurrent writers. If interrupted after its process is killed,
`.atlas-backup.lock` may remain. Stop the timer and service, confirm no backup process
is running, investigate the failure, then remove **that empty lock directory only** and
restart. Do not recursively clear the backup directory or auto-delete a possibly live
lock. The independent pruner ignores that lock and continues expiry. Fix private file
permissions or symlinks instead of disabling the checks.

## Isolated restore drill

Only restore trusted archives produced from your own ATLAS database. `pg_restore`
executes SQL from the dump; a checksum detects corruption, **not authenticity**. Transfer
both files over an authenticated private channel. Preserve their names and permissions.
Provision an isolated PostgreSQL **17** scratch cluster with verified TLS and an
administrative URL whose database is `/postgres`. Its role needs `CREATEDB` and ownership
of its newly created scratch databases. It needs no access to the live database or bucket.
The backup role cannot perform a restore.

Install the matching built worker distribution at `/opt/atlas/current`, including its
production dependencies and `dist/ops.js`. On the drill host, create a private directory
and an admin URL file readable only by the invoking operator. Run as that owner:

```sh
export ATLAS_PG_BIN=/usr/lib/postgresql/17/bin
export ATLAS_WORKER_RUNTIME=/opt/atlas/current
export ATLAS_DRILL_ROOT=/var/lib/atlas/restore-drills
export ATLAS_DRILL_ADMIN_URL_FILE=/run/atlas-drill/admin-url
node /opt/atlas/production/restore-drill.mjs \
  --archive /var/lib/atlas/backups/atlas-YYYYMMDDTHHMMSSZ-XXXXXXXXXXXXXXXX.dump \
  --out /var/lib/atlas/restore-drills/report.json
```

The script cannot accept an existing target database. It creates a random scratch DB,
checks a nonce through both database clients, restores in one transaction and verifies
the exact migration checksums. It then:

- preserves original deletion, revocation, expiry and prior purge timestamps;
- quarantines every still-active publication, fences/cancels unfinished jobs, clears
  artifact cache keys and expires restored objects;
- runs the real `atlas-ops sweep` and `reconcile-storage` implementations against
  **fresh filesystem storage** in its own directory, with owned and orphan probe bytes;
- requires every restored publication to deny access with HTTP 410 without a GitHub
  request, and verifies no nonterminal jobs or probe bytes remain;
- removes only its guarded scratch DB and its own fresh files, including credentials.

Inherited production storage settings are ignored. The sanitized JSON reports counts,
archive hash/size, failed stage if applicable, and cleanup status. A failed cleanup makes
the drill fail; investigate remaining resources in the isolated cluster. The drill
**never promotes a database or reopens traffic**.

## Real recovery boundary

A snapshot cannot contain a deletion, takedown or cancellation made after it was taken.
Running cleanup alone on an old backup is insufficient. Quarantine prevents the drill
from re-serving those stale publications, and cancellation prevents old work from
republishing them. This intentionally invalidates other restored live analyses too;
users can regenerate them after recovery.

For an actual incident, keep admission and workers stopped, preserve evidence, restore
only into an isolated cluster, apply the same quarantine/fencing policy, and reconcile
post-backup takedown and security decisions from authoritative external operator records.
Recreate least-privilege roles and grants separately (`pg_dump` does not back up cluster
globals). Use fresh artifact storage, reviewed migrations and a separate approval to
reopen traffic. Do not point this drill's cleanup at the live bucket or use its discarded
database as a promotion mechanism. Live-site recovery, delivery of alerts, a measured RTO
and an operator rehearsal remain **R6-06**, open.

## Reproduce the physical gate

```sh
docker build -f deploy/production/backup-tools.Dockerfile -t atlas-backup:m43 .
node scripts/backup-rehearsal.mjs \
  --tools-image "$(docker image inspect atlas-backup:m43 --format '{{.Id}}')" \
  --out .atlas-tmp/m43-backup.json
```

This creates a private internal network, TLS PostgreSQL, Linux volumes and authored
lifecycle fixtures. It publishes no ports and needs no live secrets. Every resource is
labelled with this run's identity and checked before removal. Only the sanitized report
is uploaded by CI; never upload volumes, dumps, certificate keys or credentials. The
systemd units are separately syntax-validated in the production rehearsal; the container
gate does not boot systemd or prove a site's timer has been installed correctly.
