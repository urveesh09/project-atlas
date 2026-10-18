# M4.4 image supply chain — 2026-10-18

[Machine-readable evidence](production-image-supply-chain.json),
[decision](../adr/ADR-075-scanned-immutable-image-publication.md),
[operator instructions](../image-supply-chain.md).

Local functional evidence on Windows, Docker Linux Engine 29.8.1, Buildx 0.37.1,
BuildKit 0.33.0 and pinned Node 24.22.0. Images were built from development changes
over `211d471ef1f0094d86a64b8a6c4e5797866f616f`; both reports explicitly record
`dirty: true`. CI independently rebuilds/scans/copies at the PR head, using the pinned
BuildKit **0.34.0** in the policy. This is not a clean release-candidate performance
measurement or a live release-signing run.

## Results

| Image | SPDX packages | Fixable findings | Blocking High/Critical | Ignored/unfixed results retained | Exact-index registry copy |
|---|---:|---:|---:|---:|---|
| API | 102 | 0 | 0 | 157 | Pass |
| Sandbox | 146 | 0 | 0 | 256 | Pass |

Both real Grype scans returned **0** and used schema v6.1.10 advisory data built
`2026-10-18T06:27:17Z`, with the checksum-bearing upstream URL in the JSON.
Reports record archive/config/platform-manifest/index identities, scanner version,
date and successful cleanup. The private registry rehearsals copied each original
OCI graph and read back the **same index digest**, so SBOM and max provenance were
retained. No host ports, public registry writes or live credentials were used.
All owned scanner caches/containers and copy-rehearsal networks/containers were removed.

Additional checks:

- `pnpm verify` with required Chromium journeys on the merged M4.3 base:
  **883 passed, 84 skipped**. Service/OS-gated skips remain disclosed.
- Eight new unit cases cover policy pins, both max-provenance versions, invalid
  statements, image mismatch, fixed High/Critical blocking, lower/unfixed results,
  scanner failures, stale data, exclusions and suppressed fixed-high findings.
- Six-repository committed baseline guard passes.
- actionlint **1.7.12**, downloaded from the official release and checksum-checked,
  accepts both changed/new workflows; `git diff --check` passes.
- CI also runs the existing real hosted acquisition/analysis/API/browser gates against
  the runtime images with package managers removed. Exact-head CI is required before merge.

## Retained failures

The old API image returned **exit 2** with eleven fixable findings, including these
three High advisories in its global npm installation:

| Advisory | Installed package | Fixed version reported |
|---|---|---|
| GHSA-rfgv-xxqx-mfg5 | undici 6.28.0 | 6.28.1 |
| GHSA-qhr7-859c-m2p7 | brace-expansion 5.0.9 | 5.0.11 |
| GHSA-6j4f-fj2g-mc7p | brace-expansion 5.0.9 | 5.0.10 |

The initial report remains in ignored `.atlas-tmp/m44-initial/api.grype.json`. Removing
unused npm/Corepack/Yarn from the final runtime layers eliminates these findings;
build-stage tooling, Node, Git and application dependency versions are unchanged.
No CVE was waived and no severity threshold was lowered.

Setup failures are retained/explained in ADR-075: an extensionless Grype configuration,
an undersized tmpfs advisory cache, unreachable Docker Desktop host-loopback registry,
unnamed OCI statements without subjects, and the first ORAS copy's incorrect generic
flag. The corrected configuration and both actual scan/copy paths pass. Failed copy
cleanup also passed. A later final run repeats both scans and copies on the merged base.

The zero count is **fixable findings**, not all advisories: ignored/unfixed results are
retained rather than hidden. Live OIDC attestation issuance/verification and GHCR
publication require an owner-approved release tag and were not performed here. CI's
read-only jobs do not create signed releases. Deployment acceptance and G6 remain open.
