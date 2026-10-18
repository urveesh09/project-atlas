# Hosted service operations

This guide covers configuration, deployment and runbooks for the hosted ATLAS service (plan §15.4, P5.6). Design decisions are in [ADR-031](adr/ADR-031-hosted-acquisition-and-analysis-pipeline.md), [ADR-032](adr/ADR-032-publication-storage-and-lifecycle.md) and [ADR-033](adr/ADR-033-hosted-flow-deployment-and-operations.md). For development setup and test commands, see [hosted-development.md](hosted-development.md).

The [production reference kit](../deploy/production/README.md) implements M4.1:
TLS proxy/API profile, file secrets, worker service and an expiring, default-deny
worker firewall. Follow its site preparation/preflight/rehearsal instructions before
an operator rollout. [ADR-072](adr/ADR-072-reference-hosted-deployment.md) records
the decisions and test boundaries. Monitoring, backup automation, supply-chain scans,
SLOs and legal pages remain M4.2–M4.6; R6-06 and G6 are open.

## Topology

```text
browser ── HTTPS ──> reverse proxy (TLS, request limits) ──> API (atlas-api serve, uid 10001)
                                                             │  PostgreSQL (role atlas_api)
                                                             └─ private S3 bucket (read; purge)
worker host (Docker engine) ── atlas-worker (uid 10001, role atlas_worker)
   ├─ broker container ── egress firewall: TCP 443 to GitHub only
   ├─ acquisition container (internal network: broker only)
   └─ analysis container (no network)
```

- The API and the worker never share a host process. The API has no Docker access.
- The worker host needs a Docker engine and a work directory, `ATLAS_WORK_ROOT`, on local disk. Sandboxes bind-mount job directories from it. Run the worker as uid 10001, the same user as the sandboxes, so it can always remove what they write.
- Dedicate each Docker engine to one ATLAS service/database and one coordinator process. Startup acquires an engine-specific database lock before cleanup and refuses a second coordinator. Use slots within that process, or separate engines for horizontal scaling. Drain/stop the old coordinator before restarting on its engine (ADR-034).
- At the network layer, allow only the broker containers' egress, TCP 443, to GitHub. Nothing else on the worker host needs outbound access except the database and storage. The application allowlist in the broker is not a substitute for this firewall.

## Configuration

Every variable listed as a secret can be given as `NAME_FILE`, with an absolute path, instead of `NAME`. The processes never log secrets, request headers, bodies, full client IP addresses or repository names; logs carry job IDs and stable codes only.

| Variable | API | Worker | Meaning |
|---|---|---|---|
| `ATLAS_DATABASE_URL` (secret) | ✓ | ✓ | Role-specific login: `atlas_api` or `atlas_worker` |
| `ATLAS_MIGRATION_DATABASE_URL` (secret) | migrate | | Schema-owner login for `atlas-api migrate` |
| `ATLAS_API_ROLE_PASSWORD`, `ATLAS_WORKER_ROLE_PASSWORD` (secrets) | migrate | | Optional: create or update both login roles and their grants |
| `ATLAS_STORAGE` | ✓ | ✓ | `s3`, or `file:/absolute/dir` for a single host |
| `ATLAS_S3_ENDPOINT`, `ATLAS_S3_REGION`, `ATLAS_S3_BUCKET`, `ATLAS_S3_ACCESS_KEY_ID` | ✓ | ✓ | Private bucket; the endpoint must use HTTPS |
| `ATLAS_S3_SECRET_ACCESS_KEY` (secret) | ✓ | ✓ | |
| `ATLAS_PUBLIC_ORIGIN` | ✓ | | Exact HTTPS origin, for example `https://atlas.example.org` |
| `ATLAS_QUOTA_SECRET` (secret) | ✓ | | At least 32 bytes; keys the daily client buckets |
| `ATLAS_TRUSTED_PROXIES` | ✓ | | Comma-separated reverse-proxy addresses whose last `X-Forwarded-For` hop identifies the client |
| `ATLAS_LISTEN_HOST`, `ATLAS_PORT` | ✓ | | Default `127.0.0.1:8080`. The image listens on `0.0.0.0:8080` for the proxy network |
| `ATLAS_OPERATOR_PORT` | ✓ | | Loopback-only metrics listener (`/metrics`, `/ready`) |
| `ATLAS_WEB_ROOT` | ✓ | | Built viewer; set by the image |
| `ATLAS_GITHUB_TOKEN` (secret) | ✓ | ✓ | Optional token with public metadata read access only. Sent only to `api.github.com`, never to Git or a sandbox |
| `ATLAS_HOURLY_JOBS`, `ATLAS_QUEUED_JOBS` | ✓ | | Admission quotas. Defaults: 5 per client per hour, 20 queued service-wide |
| `ATLAS_DEMO_ANALYSIS_ID` | ✓ | | Optional publication shown as the landing-page demo |
| `ATLAS_PRIVACY_FILE`, `ATLAS_TERMS_FILE`, `ATLAS_TAKEDOWN_FILE` | ✓ | | Absolute paths to the owner's own UTF-8 plain text for `/privacy`, `/terms` and `/takedown`, each at most 64 KiB. Required outside development; the shipped placeholders are refused ([public-service pages](#public-service-pages)) |
| `ATLAS_CONTACT` | ✓ | | The public contact: `mailto:name@domain` or an `https:` page. Required outside development |
| `ATLAS_STATUS_URL` | ✓ | | The `https:` page where incidents are announced, linked as "Service status". Required outside development ([service levels](hosted-slo.md#telling-users)) |
| `ATLAS_SANDBOX_IMAGE` | | ✓ | Immutable sandbox image ID (`sha256:…`) built from `deploy/sandbox.Dockerfile` |
| `ATLAS_DOCKER_EXECUTABLE` | | ✓ | Trusted Docker CLI path, when it is not on `PATH` |
| `ATLAS_WORK_ROOT` | | ✓ | Per-attempt scratch, on local disk |
| `ATLAS_WORKER_SLOTS` | | ✓ | Concurrent jobs. Start with one per 4 CPUs and 2.5 GiB of free memory |
| `ATLAS_DEVELOPMENT=1` | dev | dev | Enables loopback HTTP origins, fixture repositories and process isolation. **Never set it in production** |

Development-only modes refuse to start without `ATLAS_DEVELOPMENT=1`: fixture acquisition, `ATLAS_SANDBOX=process`, and HTTP origins on loopback. Process isolation also requires fixture repositories.

### Public-service pages

The hosted landing links `/privacy`, `/terms`, `/takedown` and the contact
([ADR-077](adr/ADR-077-public-service-pages.md)).
- **The wording is the owner's.** ATLAS ships only placeholders, in
  [`deploy/production/legal.example/`](../deploy/production/legal.example/). They carry the
  marker `ATLAS-PLACEHOLDER`, and the API refuses to start with them outside development.
- **The texts are plain text,** shown as text and never as markup. A blank line starts a
  new paragraph.
- **Beside the owner's text,** the privacy and takedown pages list what the code actually
  does, marked as implementation facts, not legal wording:
  - no source text is stored;
  - publications last 7 days, unless deleted sooner, and are withdrawn when their repository
    stops being public;
  - IP addresses are neither stored nor logged; a keyed daily hash is kept for 24 hours;
  - logs carry job IDs and a pseudonymous repository tag, never a name;
  - downloaded copies cannot be recalled.
- **Job records are deleted after 30 days** ([ADR-078](adr/ADR-078-record-retention-and-status.md)).
  - The hourly retention sweep deletes a job, its events, admission, checkpoint and its
    publication, artifact and upload rows, 30 days after the job ended. It does so only
    once storage has been purged and no other publication reuses its artifact.
  - It also deletes the repository row when nothing else refers to it. A taken-down
    repository keeps its row, so its revocation keeps applying.
  - Backups hold a deleted record for at most 7 days more.
  - `atlas-ops forget` runs the same sweep on demand.
- **Changing a text:** replace the file and recreate the API container. Like secrets, a
  bind-mounted file can keep its old inode.
- **A development service** without the files shows a clearly marked placeholder instead.

## Release procedure

1. **Verify the release images before deployment.** Follow
   [Image supply chain](image-supply-chain.md#what-to-verify-before-deployment): verify
   the CLI archive and both OCI index attestations against the approved workflow, tag
   and source commit; require both image scan jobs and the entire release run to pass.
   Pull by verified digest and record the engine's local image IDs. Never substitute a
   mutable tag for the reviewed image. Local development builds are:
   - `docker build -f deploy/api.Dockerfile -t atlas-api:<version> .`
   - `docker build -f deploy/sandbox.Dockerfile -t atlas-sandbox:<version> .`
   - Record both image IDs.
2. **Back up the database.** For example, `pg_dump -Fc`; see [Backups and restore](#backups-and-restore).
3. **Migrate.** Run `atlas-api migrate` with `ATLAS_MIGRATION_DATABASE_URL`, plus the role passwords on first install or after a migration that adds tables. Migrations are additive and checksummed:
   - A changed checksum stops the release.
   - A database that has a newer migration than the binary makes both the API and `migrate` refuse to run. This is the rollback guard.
4. **Deploy the API**, then the workers. Workers and APIs from the same release share the schema; new analyzer versions create new content keys and never reuse old cached artifacts.
5. **Canary.**
   - Submit the authored demo, or a pinned small public repository.
   - Confirm READY, open the city, check `/api/v1/health/ready` and the operator `/metrics`.
   - Set `ATLAS_DEMO_ANALYSIS_ID` to the new demo publication.

**Rollback.**

- Redeploy the previous images. Migrations are additive, so an older binary runs against an already-migrated schema only if it knows every applied version; otherwise it refuses.
- Never delete rows from `atlas_migrations` to force a start.
- Never rewrite an applied migration. Ship a new additive migration instead.

## Reverse proxy requirements

- Terminate TLS for the public origin only.
- Forward the original `Host` unchanged and append the client address to `X-Forwarded-For`.
- Set request body limits of 16 KiB and request timeouts of about 10 s.
- Allow `GET`, `POST` and `DELETE` only.
- Do not buffer `text/event-stream` responses: the API sends `X-Accel-Buffering: no`.
- Do not add caching to any `/api/` path. Visibility-sensitive responses send `Cache-Control: no-store`.
- Static `/assets/*` files carry `immutable` cache headers and may be cached.

## Runbooks

### Stalled job, or the reaper

Symptoms:

- `/metrics` shows `leases.expired > 0`, or an old `queue.oldestQueuedSeconds`;
- a user's job never changes stage.

Steps:

1. Run `atlas-ops reap`. It fences expired leases. A crashed attempt is retried once within its original deadline; a cancelled one ends.
2. Check that a worker is running: its `worker.started` log line, and `leases.live`.
3. A job past its 300 s deadline ends FAILED with `ANALYSIS_RESOURCE_LIMIT`.

### Worker crash

Restart the worker. At startup it removes every labelled sandbox container and network (`sandbox.reconciled` in the log). The reaper retries the interrupted job once. If a HEAD checkpoint exists, the retry reuses it (`CHECKPOINT_RECOVERED`), and the job still publishes at least HEAD. Scratch from the crashed process stays in `ATLAS_WORK_ROOT`; delete directories there that are older than one hour.

### Upstream (GitHub) outage or throttling

- Admission keeps working.
- New jobs fail with `UPSTREAM_UNAVAILABLE` or `UPSTREAM_RATE_LIMITED`. Both are retryable; nothing is published.
- Viewing an existing publication needs a visibility answer at most 5 minutes old, so during an outage it fails closed with 503. Nothing is revoked.
- `/metrics` `upstream.blockedSeconds` shows the shared back-off. Do not reset it by hand during a real limit.
- Configure `ATLAS_GITHUB_TOKEN` if anonymous quotas are the cause.
- Liveness stays healthy throughout; readiness depends only on the database, migrations and storage.

### Malicious or resource-heavy input

Sandboxes enforce the following outside the analyzed code:

- memory, PID, CPU and scratch limits;
- no network;
- the transfer budget;
- the 300 s deadline.

`ANALYSIS_RESOURCE_LIMIT` and `REPOSITORY_TOO_LARGE` are expected outcomes, not incidents. To stop a job at once, run `atlas-ops cancel <job_id>`; its containers are removed before cancellation is acknowledged. If a repository keeps causing resource failures, lower `ATLAS_HOURLY_JOBS` and investigate the job IDs. Never raise the profile limits outside an ADR.

### Purge and revocation

- **One publication:** `atlas-ops purge-analysis <analysis_id>` revokes it, then purges any storage only it held.
- **A repository that must disappear** (for example, because of legal or owner request): `atlas-ops revoke-repository <numeric_id>` revokes every publication and its content.
- **Routine:** the worker purges every minute, revalidates visibility daily, and deletes job records past the 30-day retention every hour. `atlas-ops sweep`, `atlas-ops revalidate` and `atlas-ops forget` run the same steps on demand.

Downloaded copies cannot be recalled; the landing page states this.

### Storage reconciliation

1. Run `atlas-ops reconcile-storage` until it reports `orphans: 0`. It deletes stored upload prefixes with no live or pending database row.
2. Then run `atlas-ops sweep` to finish anything left in `purging`.
3. `/metrics` `storage.purgingUploads` should return to 0. If it stays above 0, storage is failing deletes; check bucket permissions and connectivity.

### Schema rollback

See [Rollback](#release-procedure) under the release procedure. If a migration fails mid-release, it rolls back as a whole, under an advisory lock, in one transaction. Fix the cause and rerun.

### Capacity scaling

Each worker slot needs about 4 CPUs, 2 GiB of sandbox memory, 1 GiB of scratch and 256 MiB of network per attempt.

- Add slots with `ATLAS_WORKER_SLOTS`, or add more worker hosts. Claims use `SKIP LOCKED`, so any number of workers is safe.
- Raise `ATLAS_QUEUED_JOBS` only when measured queue time allows it.
- The [operator rehearsal](benchmarks/phase5-rehearsal.md) records measured end-to-end times on the reference development host.

### Secret rotation

- **Quota secret:** rotate freely. Client buckets reset, which is harmless.
- **Database role passwords:** rerun `atlas-api migrate` with new role passwords, then restart the API and workers.
- **S3 keys:** create the new key, deploy it, then delete the old one.
- **Sessions and management capabilities:** they are random values stored only as one-way hashes. A database leak does not reveal them, and there is nothing to rotate.

### Backups and restore

- Back up PostgreSQL daily with `pg_dump -Fc`; expire archives at a seven-day age cutoff.
  The reference pruner runs hourly, with catch-up after downtime; this is not a
  continuous erasure guarantee while the host is offline (ADR-074).
- Do not back up the artifact bucket. It holds no source and is reproducible.
- A restore preserves deletion, revocation and expiry rows (the rehearsal verifies this).
- After a restore, run `atlas-ops sweep` and `atlas-ops reconcile-storage`. These purge anything the restored database no longer owns and end publications that expired in the meantime.
- Never restore a database over a newer schema.

The executable reference procedure, timers, credential provisioning, retention limits
and isolated drill are in [Production backups](production-backups.md) (ADR-074).
Restores quarantine active publications and cancel unfinished jobs: an older snapshot
cannot remember deletions or cancellations made afterward. Never run a scratch
restore's cleanup against the live bucket. Real promotion and post-backup takedown
reconciliation require a separate operator procedure; R6-06 remains open.

## Metrics

`GET /metrics` on the operator port returns JSON:

| Field | Contents |
|---|---|
| `queue` | Queued, active and cancel-requested jobs; age of the oldest queued job; p95 queue wait of jobs that reached a worker in the last 24 hours |
| `leases` | Live and expired leases |
| `outcomes24h`, `failures24h` | Terminal states and failure codes over the last 24 hours |
| `stageMsP95_24h` | Per-stage p95: validate, acquire HEAD and history, analyze HEAD and history, verify, upload |
| `networkBytesP95_24h`, `artifactBytesP95_24h` | p95 network bytes and artifact bytes |
| `publications` | Live, expired, deleted, revoked, and awaiting purge |
| `storage` | Live objects and bytes; pending and purging uploads |
| `upstream` | GitHub budget: shared block time and remaining quota |
| `publicationReads` | Publication manifest and chunk reads this API process answered since it started: `ok`, `ended` (404/410), `rejected` (other 4xx), `unavailable` (5xx). Only the API's operator listener reports it, not `atlas-ops metrics` |

Alert on:

- `leases.expired > 0` for 2 minutes;
- an oldest queued job over 10 minutes;
- `storage.purgingUploads > 0` for 1 hour;
- `upstream.blockedSeconds > 0` for 15 minutes.

### Prometheus

The same endpoint answers in the Prometheus text format (0.0.4) when the request prefers
`text/plain`, as Prometheus's own scrape request does. Without that, including curl's
default, it answers JSON as before ([ADR-073](adr/ADR-073-operator-monitoring.md)).

Each field is a gauge, except the publication read counter. A null field, such as the
oldest queued job when none is queued, is left out rather than reported as 0.

| JSON field | Prometheus series |
|---|---|
| `queue` | `atlas_queue_queued`, `atlas_queue_active`, `atlas_queue_cancel_requested`, `atlas_queue_oldest_queued_seconds`, `atlas_queue_wait_p95_24h_seconds` |
| `leases` | `atlas_leases_live`, `atlas_leases_expired` |
| `outcomes24h` | `atlas_outcomes_24h{state}`: all four terminal states, 0 when none |
| `failures24h` | `atlas_failures_24h{code}` |
| `stageMsP95_24h` | `atlas_stage_p95_24h_seconds{stage}`, in seconds |
| `networkBytesP95_24h`, `artifactBytesP95_24h` | `atlas_network_p95_24h_bytes`, `atlas_artifact_p95_24h_bytes` |
| `publications` | `atlas_publications_live`, `atlas_publications_expired`, `atlas_publications_deleted`, `atlas_publications_revoked`, `atlas_publications_awaiting_purge` |
| `storage` | `atlas_storage_live_objects`, `atlas_storage_live_bytes`, `atlas_storage_pending_uploads`, `atlas_storage_purging_uploads` |
| `upstream` | `atlas_upstream_blocked_seconds`, `atlas_upstream_remaining` |
| `publicationReads` | `atlas_publication_reads_total{result}`, a counter that restarts with the API process; `rate()` and `increase()` handle the restart |

The operator listener only ever binds `127.0.0.1`, so a scraper must share the API's
network namespace. The reference kit does this with an optional Prometheus service
(Compose profile `monitoring`, see the [deployment guide](../deploy/production/README.md#monitoring)).

[`alerts.yml`](../deploy/production/alerts.yml) implements the four alerts above, each linked
to its runbook. It adds a fifth, `AtlasOperatorMetricsDown`: if scrapes fail for 5 minutes,
for example because the database is down and the listener answers 503, the other four
cannot fire. [`grafana-dashboard.json`](../deploy/production/grafana-dashboard.json) is an
optional dashboard with every series. The service-level objectives, their alerts and
incident handling are in [service levels](hosted-slo.md).
