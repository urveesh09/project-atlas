# ADR-086: Source-free scan evidence and explicit offline provenance verification

Date: 2026-10-28; implementation evidence 2026-10-29. Status: implemented for Q2.1 review;
owner authorized continued development. Live signing activation remains owner work.
Builds on ADR-085, merged in PR #52 (`43b651c`).

## Evidence and cause

Ruff SARIF does not establish which committed files were scanned, which configuration
was used, or who produced the report. A JSON field saying "verified" is forgeable.
Inventing a signing format or accepting a public key shipped inside the report would
not establish trustworthy CI provenance. GitHub already supplies artifact attestations
and a verifier with certificate-backed repository/workflow/source policy.

## Decision

1. Q2.1 adds `atlas.scan/1`: the existing source-free quality report, a constrained
   isolated Ruff profile and a producer-declared list of scanned paths/Git blobs.
   Creation validates every reference against the existing artifact, reconciles scope,
   and records omissions. It neither executes Ruff nor proves that scanning happened.
2. `atlas scan-evidence` writes this separate file exclusively, outside the artifact.
   The caller supplies the actual scanned-file declaration and profile. A signature
   must cover the complete evidence file, not a report copied into a different envelope.
3. `atlas verify-scan` uses the official **GitHub CLI 2.102.0** verifier, separately
   from analysis. It requires an operator-selected policy, local Sigstore bundle and
   local trust root pinned by SHA-256. Require exact repository, workflow path/digest,
   source commit/ref, GitHub Actions OIDC issuer, SLSA v1 predicate and hosted runner.
   No broad owner/regex policy, untrusted executable, implicit root download or token.
4. Verify immutable private copies of bounded input bytes. The subprocess receives a
   fresh configuration directory and a minimal credential/proxy-free environment,
   has bounded output/time, and is killed as a process tree on cancellation/deadline.
   Original paths, subprocess output and attestation/certificate contents never reach
   logs or the derived artifact. Verification uses explicit local inputs; no artifact
   upload, repository fetch, scanner execution or configuration execution is added.
5. Validate provenance and coverage independently. Signature success authenticates a
   statement from the configured workflow; the producer still asserts execution and
   scope. Compare declared files/blobs with analyzed Python files; never call a partial
   scope complete or confuse included analysis scope with the entire repository.
   A complete scope with lint findings is not a clean scan or a merge verdict.
6. The browser keeps `atlas.quality/1` and opens `atlas.scan/1` as an unauthenticated
   producer declaration. It rechecks file/blob references and exposes scope/profile
   accounting, preserving prior state on invalid imports. Two declared profiles must
   match before comparison. A copied receipt cannot create an authenticated badge. No
   browser trust marker, disappearing-finding resolution, durable issue identity,
   automatic quality gate or private hosting is introduced in Q2.1. Those require
   subsequent increments; the Q2 roadmap is split explicitly rather than declared done.
7. Ship a reviewed CI recipe, not an automatically activated signing/publishing job.
   Live signing depends on an owner-approved immutable workflow and configured trust
   policy after merge. Physical verifier tests must distinguish real vendor proof
   from mocked orchestration; missing live scanner attestation remains disclosed.
8. Core analyzer/artifact versions and every existing free capability stay unchanged.
   G6/R6, runtime deferral and operator-only deployment/release actions remain intact.

## Verification

Author scope/profile/identity expectations independently. Test partial and empty scope,
wrong blobs/rules, tampering, wrong signer/source policy, malformed verifier output,
nonzero exit, output limits, timeout, cancellation and input mutation. Exercise actual
GitHub CLI verification against public signed fixture material offline, including
tamper and wrong-policy failures. Keep credentials and network out of that proof.
Run full verification, distribution, baseline guard and CI before owner merge.

Actual GitHub CLI verification passes on Windows and in a network-disabled Linux
container against authentic vendor fixture material, including tampered bytes and
wrong-policy rejection. Adapter mocks are labeled separately. The existing native
process-runner tests exercise actual output limits, deadlines, descendant termination
and cancellation; this adapter reuses that runner with its own fixed limits.
The producer example passes with real isolated Ruff 0.17.3 and committed-byte checks.
The new browser journey checks declaration display, invalid-import recovery, profile
comparison, accessibility and narrow screens. Full local verification passes 1,000
tests with 92 platform/service skips. See the [functional record](../benchmarks/scan-provenance.md)
and dated [status](../implementation-status.md) for final browser/corpus/package/CI results
and the two corrected initial verifier integration failures. No live ATLAS signed scan,
human acceptance or clean/resolved verdict is claimed.

## Primary references

- [GitHub attestation verifier](https://cli.github.com/manual/gh_attestation_verify).
- [GitHub artifact attestations and their limits](https://docs.github.com/en/actions/concepts/security/artifact-attestations).
- [Attest action](https://github.com/actions/attest).
