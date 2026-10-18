# ADR-075: Scan immutable image graphs before publishing and signing

Date: 2026-10-18. Status: proposed for M4.4; exact-head CI and owner merge required.
Extends [ADR-044](ADR-044-release-engineering-and-pilot-readiness.md) and the reference
kit ([ADR-072](ADR-072-reference-hosted-deployment.md)). No analyzer/artifact/schema bump.

## Evidence and cause

The release workflow already generated `sbom: true` and `provenance: mode=max`.
Its missing controls were a vulnerability gate and enforced operator provenance
verification. It pushed version tags before scanning, and the default SBOM generator
was mutable. Rebuilding after scanning would allow the signed bytes to differ from the
tested bytes. Scanner access to a Docker socket or release credentials is unnecessary.

A real scan of the previous API image returned exit 2: three fixable High findings in
global npm's `undici` 6.28.0 and `brace-expansion` 5.0.9. None was an ATLAS application
dependency. The runtime never invokes npm, Corepack or Yarn. The retained initial
report contains eleven fixable findings total (including lower severities).

## Decision

1. Build a named, single-platform linux/amd64 **OCI archive** with SPDX and max BuildKit
   provenance, using pinned Buildx 0.37.1 and digest-pinned BuildKit 0.34.0/SBOM generator.
   Verify metadata hashes, subjects,
   platform/config/source identity and max provenance in both supported SLSA formats.
   Scanning more architectures requires a new complete scan matrix; unscanned platforms
   cannot slip into a multi-platform publication.
2. Use digest-pinned **Grype 0.120.1** against the full final filesystem. Fail on
   fixable High/Critical, invalid output, scanner errors and invalid/stale/unavailable
   advisory data. Require update checking and a maximum DB age of 120 hours. Retain the
   full JSON, including lower and ignored/unfixed results. No project exception/VEX file,
   path exclusion or suppressed fixed-high result is accepted.
3. Run the scanner as 65532 with a read-only root, no capabilities or socket, and only
   read-only archive/config mounts. Give it a private disk-cache volume, not credentials
   or a project mount. The current 3.0 GiB advisory DB cannot fit a 1 GiB tmpfs; the
   measured setup failure is retained. The cache is initialized without network using
   the existing pinned Node base, and owned resources are removed on success/failure.
4. Remove unused npm/Corepack/Yarn from the **final** API and sandbox images. Retain
   build-stage tooling. Node, Git and application dependency versions stay unchanged.
   Rescanning both rebuilt images reports zero fixable findings; unfixed advisories
   remain visible and are not represented as a vulnerability-free result.
5. Separate read-only candidate builds/scans from registry/signing permissions. Both
   candidates must pass before either publication job runs. Retain successful archives
   for one day, recheck their hash/metadata/scan evidence, then digest-pinned **ORAS 1.3.4**
   copies their complete OCI graph. Read back the registry digest; never rebuild or
   drop the attestations after scanning. There is no public candidate-tag staging step.
6. Sign the resulting index with the existing pinned GitHub attestation action, then
   verify signed repository, release workflow, tag, source commit and hosted runner.
   Apply the same verification to the CLI archive. Operator deployment requires those
   checks against an independently approved commit, plus checksum and immutable digest
   recording. A final job creates the draft only after all those jobs pass, preventing
   premature draft publication after a failed image gate. Registry index digests and
   local Docker image IDs are documented separately.
7. PR/main CI uses the same build/check commands and a real isolated-registry copy
   rehearsal, without public registry credentials/writes or live signing. OCI exports
   live outside the checkout so they cannot be copied into subsequent build contexts.
   Production publication always uses HTTPS; HTTP is restricted to a labelled internal
   fixture network with zero host ports. Existing hosted tests protect the runtime change.

## Verification and retained failures

[Dated evidence](../benchmarks/production-image-supply-chain.md) records exact archive,
platform/config/index and scanner/database identities. Both real scans and private
registry copies pass. Unit tests exercise missing/unbound/minimal attestations,
fixed High/Critical blocking (even on exit zero), database failures, exclusions,
suppression and image mismatch. `pnpm verify`, actionlint and corpus protection are
required before commit; CI repeats the new physical gates and existing hosted journeys.

Development failures were useful: `/dev/null` has no YAML extension for Grype config,
the initial 1 GiB cache filled, and an attempted host-loopback registry export was not
reachable from Docker Desktop's builder. The final design uses explicit YAML, a private
disk cache and an internal registry network. Unnamed OCI builds produced empty statement
subjects and are rejected; named builds bind them. ORAS copy uses its destination-specific
`--to-plain-http` / `--to-registry-config` flags, distinct from manifest-fetch flags;
the failed copy cleaned its resources and the corrected real copies pass. No severity
threshold, analysis deadline or accepted product gate was relaxed.

This task does not create a release tag, publish a GitHub release/GHCR image or exercise
live OIDC signing. Those require the owner's approved release. Scan evidence is dated;
future CVEs, build-stage/infrastructure image auditing and live deployment acceptance
remain separate responsibilities. R6-06 and G6 remain open.

## Primary references

- [Grype CLI](https://oss.anchore.com/docs/reference/grype/cli/) and
  [database behavior](https://oss.anchore.com/docs/guides/vulnerability/database/).
- [Docker build attestations](https://docs.docker.com/build/metadata/attestations/).
- [ORAS OCI archive copying](https://oras.land/docs/commands/oras_cp/).
- [GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify).
