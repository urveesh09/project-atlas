# ADR-105: Node 24.22.3 in the container images

Date: 2026-11-21. Status: accepted for the image security fix. Updates ADR-093's container
base and preserves ADR-075's scan policy.

## Evidence and cause

[PR #69's image run](https://github.com/urveesh09/project-atlas/actions/runs/44876845949)
blocked both the API and sandbox images. That PR changed only the viewer. The retained
Grype reports (grype 0.120.1) list seven fixable High findings, all in the `node` binary
24.22.2 inherited from the base image: CVE-2026-126051, CVE-2026-123863, CVE-2026-123864,
CVE-2026-123865, CVE-2026-123866, CVE-2026-123872 and CVE-2026-123874, each fixed in
24.22.3. Node.js published 24.22.3 as a security release on 2026-11-10
(`https://nodejs.org/dist/index.json`). `main` last passed the image gate on 2026-11-14,
before the scanner's database carried these findings, so its next run would fail the same way.

## Decision

- Use Docker's official multi-platform index for `node:24.22.3-trixie-slim`,
  `sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0`, read from
  Docker Hub's registry on 2026-11-21. Linux amd64 resolves to manifest
  `sha256:60587baa7c895cf438d44f691e4ac8248b36c13b26be77332f874bebb3a64201`, whose image
  configuration sets `NODE_VERSION=24.22.3` (created 2026-11-11). The same lookup resolved
  `24.22.2-trixie-slim` to the previous pin, `sha256:0820eaa8…3812d`.
- Replace that pin everywhere it appears: the API and sandbox images, the backup and
  validation tool images, and the isolated scanner cache initializer in
  `deploy/image-policy.json`.
- Keep ADR-093's exact zlib package pin and every other package pin. Keep the host
  toolchain minimum (`.nvmrc`, `engines`), application dependencies, scan threshold,
  image roles and analyzer and artifact formats unchanged. The hosted-gates test fixture
  image in `ci.yml` is not scanned or shipped and is unchanged.

## Verification

- The images were not built locally (the development host's Docker engine also runs
  unrelated production containers). The unchanged CI image SBOM, provenance, vulnerability
  and isolated registry checks on the exact PR head are the verification. The failed
  reports remain attached to the original run.
- No release, image publication or live deployment follows from this change.
