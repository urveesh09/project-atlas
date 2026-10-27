# Release and operations process

How ATLAS is built, released and kept healthy ([ADR-044](../adr/ADR-044-release-engineering-and-pilot-readiness.md)).
Everything here uses free GitHub features for public repositories.

## Development flow

- Work happens on short branches merged by pull request after review. The enforced
  main rules require a PR; there is no direct-push bypass (ADR-046).
- Required before merge:
  - all CI and image supply-chain jobs (`ci.yml`, `image-supply-chain.yml`);
  - CodeQL and dependency review (`security.yml`);
  - a review by the code owner.
- A known flaky failure is confirmed by rerunning only the failed job. The failure is
  recorded in `docs/implementation-status.md`, never hidden.

## Versioning

[Semantic versioning](https://semver.org/). Before 1.0, a minor version may change the
artifact format; the reader refuses unsupported versions (ADR-001 onwards). Pre-releases for
pilots use `-beta.N`.

`package.json`, `packages/cli/package.json` and `apps/web/package.json` carry the same
version. Between releases it ends in `-dev`.

## Cutting a release

1. Confirm `main` is green. Then update:
   - `docs/release/release-notes.md`;
   - `CHANGELOG.md`, moving *Unreleased* under the new version.
2. Set the version in the three package files (for example `0.1.0-beta.1`) and commit:
   `Release 0.1.0-beta.1`.
3. Tag and push: `git tag -a v0.1.0-beta.1 -m "ATLAS 0.1.0-beta.1" && git push origin v0.1.0-beta.1`.
4. The **release** workflow verifies everything again, then creates:
   - a **draft** GitHub release with `atlas-cli-<version>.tar.gz`, `SHA256SUMS`, the
     distribution smoke report and a provenance attestation;
   - both images built once as named OCI archives, with a pinned-generator SBOM and max
     provenance; both scans must pass before either image is published. ORAS preserves
     the scanned index digest, then GitHub attests it and verifies its signed identity.
     Fixable high/critical findings or scanner/database errors block the release.
5. The final job creates a draft only after CLI and both signed image publications
   pass. Review **every job in the release run**, both scan reports and signed
   identities, then publish it. Publishing also deploys the demo site.
6. Set the versions back to the next `-dev` version in a follow-up commit.

Users can check a download:

```sh
sha256sum -c SHA256SUMS
gh attestation verify atlas-cli-<version>.tar.gz --repo urveesh09/project-atlas
```

Operators must additionally constrain the signer workflow, release tag and approved
source commit for the archive **and both container digests**, and reject self-hosted
signers. Follow [Image supply chain](../image-supply-chain.md#what-to-verify-before-deployment)
for the complete commands and the distinction between registry digests and local image
IDs. Review the independently approved release SHA rather than trusting downloaded
metadata to tell you its own expected identity.

## Demo site

`demo site` workflow (manual, and on every published release):
1. acquires the pinned corpus commits;
2. analyzes them offline;
3. requires the committed baseline bytes;
4. builds the static viewer around the verified **vuejs/core** artifact;
5. opens the built site in Chromium from a sub-folder, as Pages serves it
   (`scripts/check-demo-site.mjs`). The city must load and a file must open in the
   inspector, every request must stay inside the site folder and succeed, and the page
   must log no errors;
6. deploys to GitHub Pages, from `main` or a published release only. Dispatched from any
   other branch, the run stops after the check.

Locally:

```sh
pnpm build
node scripts/validate-real-repositories.mjs --acquire && node scripts/validate-real-repositories.mjs
node scripts/build-demo-site.mjs --artifact .atlas-tmp/release-corpus/vuejs-core/artifact --out .atlas-tmp/demo-site
node scripts/check-demo-site.mjs .atlas-tmp/demo-site
```

## Security and dependencies

- Private vulnerability reports arrive under **Security → Advisories** ([SECURITY.md](../../SECURITY.md)).
  Acknowledge within 3 working days.
- CodeQL alerts appear under **Security → Code scanning**. Triage them weekly with the
  Dependabot pull requests.
- Dependabot pull requests are proposals: run CI, read the changelog, and for anything that
  could change output bytes run the corpus baseline. Toolchain bumps are deliberate decisions
  (docs/toolchain.md).
- OpenSSF Scorecard publishes a public score weekly.

### Monthly image maintenance

- Resolve the official `postgres:17-alpine` multi-architecture index with
  `docker buildx imagetools inspect postgres:17-alpine`. Review its version and digest
  against both `.github/workflows/ci.yml` and `deploy/compose.yaml`; propose changes
  through a pull request and require the hosted service gates. Dependabot's Docker
  job watches `/deploy`, not image references inside workflow files.
- On the exact Node base pinned in `deploy/sandbox.Dockerfile`, run
  `apt-get update && apt-cache policy git`, including `trixie-security`, and record
  the date and candidate in the dependency ADR. Keep the Git version exact. A build
  failure caused by Debian superseding the pinned Git package means **update the
  pin**, then rebuild the sandbox and pass the hosted container gates; do not remove
  the version constraint or bypass the security suite.

These currency checks accompany the M4.4 image vulnerability gate. Its reports record
dated advisory data; they do not establish zero vulnerabilities or production sign-off.

## Pilot feedback

Pilot users file the **Pilot feedback** issue form. Review the forms weekly and record:
- how many pilots completed their task;
- the friction they hit;
- how many came back the following week.

That evidence, with the R6-03 usability protocol, decides what to build next. It is a
precondition for any paid service (ADR-044).

## Owner settings

These need repository admin rights. They are not changed by workflows.

| Setting | Where | Why |
|---|---|---|
| Pages source: **GitHub Actions** | Settings → Pages | Lets the demo-site workflow deploy |
| `github-pages` environment: allow tags `v*` as well as `main` | Settings → Environments | A published release deploys from its tag. With only `main` allowed, GitHub rejects that deploy; until then, run `demo site` from `main` after publishing |
| Private vulnerability reporting: on | Settings → Code security | The private channel in SECURITY.md |
| Dependabot alerts and security updates: on | Settings → Code security | Advisories for pinned dependencies |
| Ruleset on `main`: CI and security checks required, no force pushes or deletion | Settings → Rules | Keeps `main` releasable |
| Packages `atlas-api` and `atlas-sandbox`: public | Packages, after the first release | Lets operators pull images without a login |
