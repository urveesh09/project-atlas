# ADR-044: Release engineering, supply chain and pilot readiness

Date: 2026-10-12. Status: accepted. Builds on [ADR-035](ADR-035-release-candidate-evidence-and-distribution.md)
(release candidate evidence and the portable CLI). Changes no contract, artifact byte or
analyzer version.

## Evidence and cause

An external audit judged ATLAS ready for customer discovery and controlled pilots, but not
for a subscription launch. Its main gaps were product validation and service readiness. The
owner directed that development-operations work start, professionally and with free
tooling. The repository had one CI workflow and no release automation. It also had:
- no published images or checksums;
- no security policy, private reporting path or code scanning;
- no dependency update process;
- no contribution, issue or pilot-feedback forms;
- no link a prospect could open without installing anything.

## Decision

1. **Trunk-based development on `main`.** Pull requests are the default; CI (eight jobs) and
   the security workflow must pass. CODEOWNERS routes every change to the maintainer.
2. **Releases from version tags** (`.github/workflows/release.yml`).
   - A tag `vX.Y.Z[-pre]` must equal the version of every package
     (`scripts/check-release-version.mjs`), and `-dev` versions are refused.
   - The job runs the same `pnpm verify` and `pnpm verify:distribution` as CI.
   - It publishes the portable CLI archive with `SHA256SUMS`, the distribution smoke
     report and a GitHub build-provenance attestation.
   - The release is created as a **draft**; a maintainer reviews and publishes it.
   - The API and sandbox images go to GHCR, tagged with the version, with SBOM and
     provenance. Operators still deploy by image ID (docs/hosted-operations.md).
3. **Supply chain** (`.github/workflows/security.yml`, `scorecard.yml`, `dependabot.yml`).
   - CodeQL (`security-extended`) on pushes, pull requests and weekly.
   - Dependency review on pull requests, failing on high-severity advisories and
     copyleft licences that conflict with the MIT bundle.
   - OpenSSF Scorecard, published weekly.
   - Dependabot proposes monthly, grouped updates. Toolchain bumps (TypeScript, three.js
     minors) are excluded, because pinned versions are deliberate (docs/toolchain.md).
     Nothing merges automatically.
4. **A static demo** (`scripts/build-demo-site.mjs`, `.github/workflows/demo-site.yml`).
   - A demo build of the viewer (`VITE_ATLAS_DEMO_BASE`) opens a bundled artifact from a
     relative folder, through the same validation as every other load.
   - The workflow acquires the pinned corpus commits, analyzes them offline, requires the
     committed baseline bytes, verifies the vuejs/core artifact, and deploys to GitHub
     Pages. It runs on demand and when a release is published.
   - The artifact holds paths, metrics and relationships of a public MIT repository, never
     its source text. Publishing it is an explicit, recorded act of sharing.
   - Demo builds show a "Run on your repository" link. Ordinary builds are unchanged.
5. **Community and pilot intake.**
   - `SECURITY.md` asks for private reports through GitHub; no email is published.
   - `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1) are added, with
     a pull-request template carrying the evidence checklist.
   - Issue forms cover bugs, feature ideas and **pilot feedback**. The pilot form asks for
     the task, whether ATLAS helped, the best moment, friction and intent to return.
     These are the signals the audit said must be proven before a paid service.

Not decided here:
- accounts, billing and team workspaces;
- any paid service or telemetry.

Those need pilot evidence first and a separate ADR. The plan's runtime-telemetry deferral
is unchanged.

## Verification

- `actionlint` 1.7.7: 0 errors in the 5 workflows. Every workflow, issue-form and Dependabot
  file parses as YAML.
- `check-release-version.mjs` refuses `v0.1.0-dev` (development version), `0.1.0` (not a
  tag) and `v0.1.0` or `v0.1.0-beta.1` while the packages declare `0.1.0-dev`.
- The static demo was built from the vuejs/core corpus artifact (`atlas verify` passed).
  Served by a plain static server below `/project-atlas/`, as on Pages, Chromium opened
  vuejs/core with 702 plots and the 3D city drew.
  - The only failed requests were the expected 404s of the local-session and
    hosted-service probes.
  - A first build failed with `MANIFEST_MISSING`: the loader worker resolved the relative
    `demo/` against its own script URL. The base is now resolved against the page first.
- Settings that only the repository owner can change are listed in
  [the release process](../release/release-process.md#owner-settings). Until they are
  applied, the release and demo workflows are present but unused.
