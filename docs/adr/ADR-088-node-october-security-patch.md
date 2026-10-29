# ADR-088: Node 24.22.1 security patch

Date: 2026-10-29. Status: accepted. Amends ADR-061's runtime pin;
the image scanning policy in ADR-075 is unchanged.

## Evidence and cause

PR #54's first image supply-chain run
[40891822901](https://github.com/urveesh09/project-atlas/actions/runs/40891822901)
blocked both images at commit `ac62e98`. Its current Grype database reports
CVE-2026-111497, CVE-2026-105482, CVE-2026-106069 and CVE-2026-105483 against
Node 24.22.0. Node's [October security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
identifies 24.22.1 as the patched 24.x version. No finding is suppressed.

## Decision

- Pin the supported toolchain and all Node container bases/cache initialization to
  24.22.1. Keep pnpm and application dependencies unchanged.
- Resolve official `node:24.22.1-trixie-slim` with `docker buildx imagetools inspect`:
  index `sha256:89c5244bc22a9bc3287d89ebc7e49b9cb5bb84cd40e6175ac3421d5a9f68b95a`,
  Linux amd64 manifest `sha256:c8c4a7483bb04544293c82a3eecc3081c37ff5dfedcaf819d60e6e4aaad35b12`.
  Dockerfiles retain the multi-platform index pin; the image gate retains linux/amd64.
- Doctor compares the patch component as well as major/minor. Older 24.x remains
  diagnosable with a security warning; unsupported majors fail as before.
- Keep historical reports and measurements unchanged. Recheck exact corpus bytes
  rather than changing analyzer or artifact identity for a runtime-only patch.
- No release, publication or deployment follows from this maintenance change.

## Verification

The official Windows archive was checked against Node's published SHASUMS256.txt:
`d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5`.
`pnpm verify` on that runtime passes 1,021 tests (92 gated skips), including the
53 Chromium journeys and real GitHub verifier fixtures. Corpus/package evidence is
recorded in the implementation status; fresh exact-head image scans and the complete
CI matrix are required on the PR. The initial failed scan reports remain attached
to the first CI run; this does not erase them.
