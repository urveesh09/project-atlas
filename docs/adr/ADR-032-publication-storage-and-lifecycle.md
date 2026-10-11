# ADR-032: Publication, private storage and lifecycle

Date: 2026-10-11. Status: accepted (P5.4). Implements plan §8.6, §13.1, §13.3 and §13.4 on the ADR-029 schema (additive migration 002).

## Decision

### Private storage

The `ObjectStore` interface has two implementations:

- a filesystem store, with atomic writes and bounded reads;
- an S3-compatible store: path-style, AWS Signature V4 over `fetch`, HTTPS required except on loopback, no SDK.

Keys are fixed shapes only: `uploads/up_<128-bit>/` plus `manifest.json` or a chunk path from the artifact grammar. No caller path ever becomes a key.

Nothing is public. The API streams a chunk only after its checks, with `Cache-Control: no-store`. No presigned or public URLs exist.

### Uploads before rows

An `uploads` row (pending) exists before the first byte is written. Each object is read back and compared byte for byte. The prefix becomes `live` only inside the lease-fenced publication transaction.

Garbage collection deletes:

- interrupted, fenced, cancelled or superseded uploads;
- checkpoints of finished jobs;
- everything already marked `purging`.

Reconciliation deletes stored prefixes that have no live or pending row.

### Content and publications

`artifact_objects` is keyed by a content key: the analysis key plus every chunk hash. Identical content from two jobs is stored once.

Each submission gets its own `analysisId`, expiry (7 days) and management capability. The public manifest is the stored manifest with that publication's ID and expiry substituted, then re-validated.

Only complete results carry a cache key: repository numeric ID, commit, profile, history choice and analyzer version. A partial result can never stand in for a complete one, and a later identical submission is served as a new publication without analysis.

### Access check, on the manifest and every chunk

The check runs in this order:

1. Publication exists (else 404 `ARTIFACT_NOT_FOUND`).
2. Not deleted (410 `ARTIFACT_DELETED`).
3. Not revoked, and the repository is still public (410 `ARTIFACT_REVOKED`).
4. Not expired (410 `ARTIFACT_EXPIRED`).
5. Storage not purged.
6. Visibility answer at most 5 minutes old. Otherwise it is refreshed by numeric ID through the pinned, budgeted client; renames and transfers keep a public repository visible. An outage or throttle fails closed with 503 and never revokes.

A chunk must be listed in that publication's manifest, and its stored length must equal the manifest's. A storage outage is a retryable 503; a size mismatch is `ARTIFACT_INVALID`.

### Revocation and purge

A repository found unavailable has every publication revoked. Its cached content loses its cache key and expires at once, so it is purged even if the repository becomes public again. A new submission may then analyze it afresh.

The purge sweep:

1. ends expired, deleted and revoked publications;
2. deletes content no live publication needs, marking rows `purging` before deletion and `purged` after;
3. is idempotent after a crash.

A daily revalidation checks repositories that still have live publications.

### Owner deletion and operators

`DELETE /analyses/:id` requires management access to the job that created the publication (its session or Bearer capability) and exact Origin. Deleting one publication never touches another's content or capability, and never changes the job's terminal state.

Operators have `atlas-ops purge-analysis`, `revoke-repository`, `sweep` and `reconcile-storage`.

## Evidence

`apps/worker/test/pipeline.test.ts` and `hosted-http.test.ts` run on real PostgreSQL. In CI they also run on a real S3 gateway (Versity, pinned digest). They cover:

- listed-chunk serving and unknown or traversal IDs;
- visibility caching, revocation and purge, and re-analysis after the repository is public again;
- fail-closed outage;
- simulated-clock expiry and purge;
- per-capability deletion with shared content surviving;
- the storage-outage 503 and orphan reconciliation;
- upload failure leaving nothing published;
- 410 bodies containing no graph;
- `no-store` on every graph response.

`packages/control/test/control.test.ts` covers:

- key grammar;
- cache-key inputs;
- filesystem atomicity;
- S3 signing, bounds and wrong-credential refusal on the real gateway;
- configuration failures;
- the shared upstream budget.

## Consequences

- Visibility checks consume GitHub API quota: one per repository every 5 minutes while it is being viewed, plus a daily sweep. Operators should configure a minimum-scope token.
- A manifest-sized read happens per access, cached per process by immutable upload ID.
- Copies already downloaded by viewers cannot be recalled; the landing page says so.
