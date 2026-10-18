# M4.1 production reference deployment evidence

Date: 2026-10-18. Functional configuration/transport/isolation rehearsal, not a
capacity or production-site acceptance measurement. Decision: [ADR-072](../adr/ADR-072-reference-hosted-deployment.md).

## Environment and identities

Windows development host, Intel Core i5-10400 (6 physical cores), 17,093,009,408 bytes
reported physical memory; Docker Desktop Linux Engine 29.8.1. Host Node 24.22.0,
pnpm 10.34.6, Python 3.14.5. This is not the R6 reference host or a deployed server.

The [machine-readable report](production-reference-deployment.json) records base Git
identity, dirty state, SHA-256 of consumed configuration/tooling and immutable API,
proxy/validator/PostgreSQL/S3 image identities. Local runs deliberately identify
uncommitted implementation as dirty; they are not a release candidate. The exact-head
clean-checkout CI report is the `production-rehearsal` artifact on the task pull request.
Service configuration is tested from the working files; images run compiled applications.
After this report, the rehearsal's HTTPS client was changed to load its CA into a
dedicated agent, after CodeQL review (ADR-072). The report's digest for
`scripts/production-rehearsal.mjs` is therefore of the earlier client. The change was
rehearsed again locally, and CI's report covers the final file.
Analyzer/artifact/package versions and application analysis bytes are unchanged.

## Checks

The production transport rehearsal contains 14 named passing steps:

- A throwaway CA and hostname-verified leaf certificate; no TLS-verification bypass.
- Resolved production profile: immutable images, uid 10001, read-only roots, no added
  capabilities, no-new-privileges, named file secrets, isolated ports and correct proxy trust.
- Actual production Caddyfile validation in the pinned derived Caddy image.
- Actual nft rules plus freshly fetched GitHub git/API ranges, validated in an isolated
  namespace. No host firewall is read or modified.
- Actual worker/firewall/refresh units and Docker ordering drop-in verified with
  systemd 257.13, using an inert Docker stand-in. This does not boot systemd.
- Real routed packet policy: positive controls before installation; broker HTTPS/DNS
  allow; HTTP/database/nonbroker forwarding and host-relay deny; coordinator-only
  database egress; failed atomic update preserves the old set; expired set denies new
  connections. Deny counters witness actual packets. Fixture interfaces/destinations
  replace production addresses only in the router container's namespace.
- Private S3 fixture via verified HTTPS.
- Real migrations provision roles and the production API becomes healthy with
  `ATLAS_DEVELOPMENT` absent.
- TLS rejects an untrusted CA; the trusted connection receives HSTS, no-store and a
  Secure/HttpOnly/SameSite session cookie. Full readiness and the actual healthcheck
  reject a stopped storage endpoint and recover when it returns.
- Unsupported methods return 405. Exactly 16,384 bytes reach API schema validation;
  16,385 bytes are rejected as oversized.
- Forged Origin returns 403; a different HTTP Host returns 421.
- Real API admission, a queued SSE event received before completion, cancellation
  and terminal event under HTTPS. No worker is run in this transport fixture.
- Thirty sessions reach the real per-client quota even with changing forged XFF;
  the next request receives 429.
- API runtime role cannot create a table (PostgreSQL permission error 42501).

All owned production-profile and packet-fixture containers/networks are removed.
The separate existing physical hosted gates pass **185/185** locally, including
PostgreSQL, S3, actual Docker isolation/resource/egress paths, TS/JS and Python history,
publication and **7/7 Chromium hosted journeys**. That run preceded three additional
IPv6 metadata rejection cases; the final full suite includes all 42 operator-tooling
regressions. CI repeats the complete final source. This separation avoids enabling
fixture/development acquisition in the production transport profile.

`pnpm verify` passes **855 checks**, with **83 intentionally service-gated skips**,
including **48/48 Chromium viewer journeys**. Type checking, viewer build, dependency
direction and generated contracts pass. The six-repository committed baseline guard
passes without a version bump. Hosted accessibility reports retain 17 checkpoints;
viewer reports retain 49; no axe violation was reported, and incomplete/manual checks
remain available rather than being treated as conformance. Browser code is unchanged;
Firefox/WebKit and three-OS corpus/CLI evidence are repeated in CI.

## Retained failures and corrections

1. An early packet fixture closed successful connections abruptly and did not handle
   the peer's socket reset. The peer exited. Handle fixture errors, retain pre-filter
   positive controls and require actual deny counters; do not count a dead peer as a deny.
2. First production report failed executing upstream Caddy under an empty bounding
   set. The derived image removes its unused bind-service file capability, retaining
   all hardening. The actual production configuration subsequently validates/runs.
3. Second report failed with `Address already in use`: dynamic allocation had taken
   the trusted proxy address. Reserve a separate dynamic range and reject collisions
   in preflight and a dedicated regression.
4. Third report failed at the first HTTPS request. Its generic `Error` record does
   not retain the precise TLS alert. The final client uses localhost SNI/Host, a
   matching CA-signed DNS leaf and verified trust; explicit untrusted-CA rejection
   also passes. Do not infer an exact original alert from the corrected run.
5. Final readiness review replaced a DB-only probe. Its draft fetch-based request
   rewrote Host (independently witnessed inside the API image), failing the existing
   origin guard. Use `node:http` with the configured Host, retain the four-second
   probe deadline, and execute the actual check across storage failure/recovery.

These reports/logs remain in ignored `.atlas-tmp/m41-*` and generated project scratch.
Subsequent passing reports do not replace the failures. No timeout, security assertion,
capacity limit, analyzer version or baseline was weakened.

## Acceptance still required

R6-06 needs real Linux boot ordering, live domain/TLS and renewal, fixed resolver and
destination configuration, actual host firewall/Docker backend interaction, private
bucket IAM, deployed least-privilege identities and canary/recovery evidence. Static
unit validation and remapped packet tests do not supply those results. Worker graceful
stop waits for maintenance as well as deadline-bounded jobs, so the unit intentionally
has no guessed finite drain timeout. Operators must observe drain and use the existing
crash/reaper runbook if forced recovery is necessary.

M4.2 monitoring/alerts, M4.3 automated backup drill, M4.4 image scans/attestations,
M4.5 SLOs and M4.6 owner-supplied legal/contact configuration remain separate tasks.
R6-01…R6-07 and G6 remain open. See the pull request for the final exact-head CI and
review-thread status; no public deployment or release approval is claimed here.
