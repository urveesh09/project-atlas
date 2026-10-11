# ADR-033: Hosted flow, deployment and operations

Date: 2026-10-11. Status: accepted (P5.5, P5.6).

## Hosted flow (P5.5)

The same viewer bundle serves three modes:

- local (`atlas serve`);
- browser-only (picked folders, never uploaded);
- hosted.

The hosted API serves the built viewer on its own origin for `/`, `/jobs/<jobId>` and `/a/<analysisId>`, with a same-origin CSP. A hosted publication loads through the same validating worker as a local artifact: manifest first, then chunks by opaque ID, with every hash and invariant checked.

**Landing.** One repository-root field and a history choice. A concrete public-output notice must be accepted before submission: link visibility, what is revealed, withdrawal and copies. It also shows the language and limit summary, the demo when the operator maintains one (`demoAnalysisId` in capabilities), and the local route.

**Submission.** Uses a UUID idempotency key kept in the tab until answered, so a retried click never queues twice. The management token in the response is discarded. Authority is the HttpOnly SameSite=Strict session, so no secret ever reaches script state, storage or a URL.

**Job page.** Shows stage marks and counts as "n of N", never an invented percentage. It also shows:

- the queue position;
- elapsed time from `createdAt`, including time in the queue;
- warnings in ATLAS-authored text;
- cancellation;
- the failure code with guidance, offering a retry when the failure is retryable.

Updates come by SSE. Every event triggers an authoritative status read. When SSE fails, polling takes over: every 2 s, backing off to 10 s while nothing changes. The immutable result URL opens the explorer.

**Result.** The explorer shows the expiry, a new-analysis link and inline-confirmed deletion. Deletion succeeds only for the submitting session.

**Lifecycle screens.** 404, 410 and fail-closed 503 answers get explanation screens with a way forward, never a stale graph.

## Deployment (P5.6)

**API.** `deploy/api.Dockerfile` builds a non-root API image with the viewer included. Production requires:

- an HTTPS public origin;
- a quota secret of at least 32 bytes;
- current migrations.

Every secret can be given as `NAME_FILE`.

**Client identity.** Behind a reverse proxy, `ATLAS_TRUSTED_PROXIES` names the proxy addresses whose last `X-Forwarded-For` hop is trusted. Everything else uses the socket address.

**Operator endpoint.** A separate loopback port serves aggregate metrics: queue, leases, outcomes, stage p95s, bytes, storage and upstream budget.

**Migrations and roles.** Migrations run as a release step (`atlas-api migrate`) under the schema owner. They can (re)provision two login roles:

- `atlas_api`: admission, status, events, publication reads, deletion and the purge it triggers;
- `atlas_worker`: claims, progress, uploads, checkpoints, publication, sweeps.

Neither role has DDL, TRUNCATE or the other's inserts. The API role cannot create a publication; the worker role cannot create sessions or read admissions.

**Worker.** The worker runs on a Docker host as uid 10001, with `ATLAS_SANDBOX_IMAGE` pinned to an image ID. It reconciles stale sandboxes at startup.

**Compose.** `deploy/compose.yaml` defines a loopback development and rehearsal stack: PostgreSQL, the S3 gateway, a migration job and the API. Secrets are files.

**Development launcher.** `scripts/hosted-dev.mjs` starts the real API and worker processes from environment configuration.

## Evidence

- Six Chromium journeys with automated WCAG 2.2 AA audits (`hosted.e2e.test.ts`):
  - success, keyboard opening and deletion;
  - PARTIAL;
  - retryable failure;
  - cancellation;
  - SSE blocked with polling recovery;
  - expired, unknown and foreign-session screens.

  The journeys record every request URL and assert that neither the management token nor the session ever appears in one.
- The HTTP journey runs the API and worker under the least-privilege roles. This found that admission needs `UPDATE` on `sessions` for its `FOR SHARE` lock; that is the only grant beyond read/insert/delete there.
- `scripts/hosted-rehearsal.mjs` exercises a fresh database, migrations and roles, real processes, journeys, medium-repository timing, operator cancellation, worker SIGKILL recovery from the checkpoint, operator purge, backup/restore preserving revocation, and the rollback guard. The report is `docs/benchmarks/phase5-rehearsal.md`.

## Not decided here

- TLS termination and the public reverse proxy are operator infrastructure. `docs/hosted-operations.md` states the required headers and limits.
- The release definition (P6) still needs a public deployment of the service, its egress firewall, reference-hardware capacity runs and human accessibility audits.
