# Image supply chain and release verification

M4.4, [ADR-075](adr/ADR-075-scanned-immutable-image-publication.md).
The release gate covers the **API and sandbox** images, on **linux/amd64**. Other
architectures must be scanned before they can be added. Operator infrastructure images
(PostgreSQL, proxy, monitoring and backup tooling) have separate maintenance requirements.
This does not publish a release or approve a production deployment.

## Release path

1. The CLI job verifies the release version, runs the full suite and distribution smoke,
   attests the archive and verifies its signed workflow/tag/commit before retaining the
   candidate for the final draft job.
2. Both image candidates build **once** as OCI archives, with an SPDX inventory and
   maximum BuildKit provenance. Buildx is fixed at 0.37.1, and CI's BuildKit 0.34.0
   and SBOM generator are pinned by digest. Named image
   outputs bind both statements to the platform manifest; unnamed outputs with empty
   statement subjects are rejected.
3. The gate validates the OCI metadata hashes, single platform, uid 10001, source label,
   attestation linkage and nonempty SPDX inventory. Both BuildKit SLSA v0.2 and v1 max
   formats are understood; minimum provenance does not pass.
4. A pinned Grype 0.120.1 container scans each archive's complete final filesystem.
   The scanner has no Docker socket, registry credentials, workspace mount or release
   permission. It runs as 65532, with a read-only root, no capabilities and private
   disposable cache storage. The advisory DB currently occupies about **3.0 GiB**;
   allow at least 8 GiB free disk per scan for download/unpacking plus image/build storage.
5. **Fixable High or Critical findings block publication.** Scanner errors, missing or
   stale DBs, mismatched image identities, excluded paths and suppressed fixed high
   findings also fail closed. The database auto-updates, requires a successful update
   check and must be valid and ≤120 hours old. No project CVE allowlist, VEX exceptions,
   path exclusions or severity overrides ship. Lower/unfixed findings remain in the
   full JSON, including its ignored/suppressed list; passing does not mean zero CVEs.
6. Only when **both** image candidates pass does the publication job receive registry
   write/signing permissions. It rechecks the archive hash, metadata and scan evidence,
   then pinned ORAS copies the original OCI graph. There is no rebuild after scanning.
   A registry readback must match the scanned index digest, preserving the SBOM and
   provenance along with the runnable image.
7. GitHub signs that index's provenance. The job verifies repository, signer workflow,
   tag, commit and hosted-runner identity. Only after the CLI and both signed images
   pass does the final job create a draft. Publishing it remains an owner action;
   review the **entire** release run and evidence before publishing.

The ordinary PR/main workflow runs the same archive build/check and a private registry
copy rehearsal. It has read-only repository permissions, no release credentials and no
public registry writes. Its fixture uses HTTP only inside its labelled internal network,
with zero host ports; the production publisher always uses HTTPS. Reports survive a
failure. Only successful release candidates upload their tar to another job, retained
for one day. PR artifacts contain JSON/logs only. Work directories, scanner containers,
disk volumes and registry networks are checked for ownership before removal.

## What to verify before deployment

Get the expected release commit from the owner's approved release identity record.
Do not derive your expected identity from the artifact being verified. The CLI and
container attestations must come from this repository's **release.yml**, for the exact
tag and approved commit. Authenticate to GHCR first if the packages are not public.

```sh
VERSION=0.1.0-beta.2                 # replace with the approved version
RELEASE_COMMIT='REPLACE_WITH_APPROVED_FULL_COMMIT_SHA'
REPOSITORY=urveesh09/project-atlas
SIGNER=$REPOSITORY/.github/workflows/release.yml

gh release download "v$VERSION" --repo "$REPOSITORY" \
  --pattern "atlas-cli-$VERSION.tar.gz" --pattern SHA256SUMS
sha256sum -c SHA256SUMS
gh attestation verify "atlas-cli-$VERSION.tar.gz" --repo "$REPOSITORY" \
  --signer-workflow "$SIGNER" --source-ref "refs/tags/v$VERSION" \
  --source-digest "$RELEASE_COMMIT" --deny-self-hosted-runners

for image in api sandbox; do
  repository="ghcr.io/urveesh09/atlas-$image"
  digest=$(docker buildx imagetools inspect "$repository:$VERSION" --format '{{.Manifest.Digest}}')
  gh attestation verify "oci://$repository@$digest" --repo "$REPOSITORY" \
    --signer-workflow "$SIGNER" --source-ref "refs/tags/v$VERSION" \
    --source-digest "$RELEASE_COMMIT" --deny-self-hosted-runners
  docker pull --platform linux/amd64 "$repository@$digest"
  docker image inspect "$repository@$digest" --format '{{.Id}}'
done
```

Stop on any failure. Record the release workflow run, approved commit, registry index
digests and local image IDs. Registry digests bind the published OCI graph; local image
IDs identify the engine's stored images. Do not confuse the two: `ATLAS_SANDBOX_IMAGE`
takes the local immutable image ID after the verified pull. Configure the API with its
verified `repository@digest`. Never deploy a mutable version tag without resolving and
verifying it. A changed tag will not silently change the pinned deployment.

The existing CLI checksum checks accidental corruption; the attestation additionally
checks signed origin. Neither establishes that application code is bug-free, nor that
new vulnerabilities have not appeared since the dated scan. Review the saved SBOM,
scan results and current advisories before rollout, and keep the existing monthly image
maintenance process. Do not bypass a failed job or publish an incomplete manually created draft.

## Reproduce without publishing

Use the repository's pinned Node/Docker tools. In a fresh ignored output directory:

```sh
mkdir -p .atlas-tmp/image-check
revision=$(git rev-parse HEAD)
generator=$(node -p "require('./deploy/image-policy.json').sbomGenerator")
for image in api sandbox; do
  docker buildx build --file "deploy/$image.Dockerfile" --platform linux/amd64 \
    --tag "atlas-$image:candidate" --provenance=mode=max \
    --attest "type=sbom,generator=$generator" \
    --label "org.opencontainers.image.revision=$revision" \
    --metadata-file ".atlas-tmp/image-check/$image.metadata.json" \
    --output "type=oci,dest=.atlas-tmp/image-check/$image.tar" .
  digest=$(node -p "require('./.atlas-tmp/image-check/$image.metadata.json')['containerimage.digest']")
  node scripts/image-supply-chain.mjs check \
    ".atlas-tmp/image-check/$image.tar" "$digest" "$revision" ".atlas-tmp/image-check/$image-reports"
  node scripts/rehearse-image-copy.mjs \
    ".atlas-tmp/image-check/$image.tar" ".atlas-tmp/image-check/$image-reports/image.json" "$revision"
done
```

`check` retains full Grype JSON/logs, SPDX, BuildKit provenance and a summary with source
label, working-tree state, date, archive/config/manifest/index identities and database
identity. Invalid metadata stops before scanning. Failed scans retain diagnostics and
return nonzero. `rehearse-image-copy` confirms the same published index digest in a real
private registry, and removes only its own resources. No live OIDC signing, release tag,
public package or public service is created by these commands.

If a scan is interrupted by killing the parent process, inspect resources labelled
`atlas.image-scan` or `atlas.image-rehearsal`; identify the interrupted run before
removing anything. Ordinary success and thrown failures clean their owned resources.
Never perform a global Docker prune. Cache size limits are operator tooling limits,
not the analyzer's 2 GiB job budget.

## Pin maintenance and triage

All helper images are fixed in [image-policy.json](../deploy/image-policy.json), with
the scan settings in [grype.yaml](../deploy/grype.yaml). Review official release
identities, digest and version together, then run both physical image gates and the
existing hosted gates. No floating scanner/SBOM/publisher tag executes in CI.
The advisory database intentionally changes with upstream feeds; each scan records its
built timestamp and checksum-bearing source URL rather than freezing obsolete advisories.

Fix a finding in the shipped image or update its dependency deliberately, with normal
tests and corpus protection. Do not hide it with exclusions or an exception file. The
first run found three high advisories in npm's bundled dependencies; removing unused
package managers from the final images eliminated them without changing Node, Git,
application dependencies or analysis output. Build stages retain their package managers.

Live release signing/GHCR visibility, rollout and acceptance still require an approved
version tag and the operator's R6-06 process. This preparation does not close G6.
