# Release and operations process

How ATLAS is built, released and kept healthy ([ADR-044](../adr/ADR-044-release-engineering-and-pilot-readiness.md)).
Everything here uses free GitHub features for public repositories.

## Development flow

- `main` is always releasable. Work happens on short branches merged by pull request after
  review. The maintainer may push small changes directly while working solo; CI still runs.
- Required before merge:
  - CI, all eight jobs (`.github/workflows/ci.yml`);
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
   - images `ghcr.io/urveesh09/atlas-api:<version>` and `atlas-sandbox:<version>`, with SBOM
     and provenance.
5. Review the draft and publish it. Publishing also deploys the demo site.
6. Set the versions back to the next `-dev` version in a follow-up commit.

Users can check a download:

```sh
sha256sum -c SHA256SUMS
gh attestation verify atlas-cli-<version>.tar.gz --repo urveesh09/project-atlas
```

## Demo site

`demo site` workflow (manual, and on every published release):
1. acquires the pinned corpus commits;
2. analyzes them offline;
3. requires the committed baseline bytes;
4. builds the static viewer around the verified **vuejs/core** artifact;
5. deploys to GitHub Pages.

Locally:

```sh
pnpm build
node scripts/validate-real-repositories.mjs --acquire && node scripts/validate-real-repositories.mjs
node scripts/build-demo-site.mjs --artifact .atlas-tmp/release-corpus/vuejs-core/artifact --out .atlas-tmp/demo-site
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
| Private vulnerability reporting: on | Settings → Code security | The private channel in SECURITY.md |
| Dependabot alerts and security updates: on | Settings → Code security | Advisories for pinned dependencies |
| Ruleset on `main`: CI and security checks required, no force pushes or deletion | Settings → Rules | Keeps `main` releasable |
| Packages `atlas-api` and `atlas-sandbox`: public | Packages, after the first release | Lets operators pull images without a login |
