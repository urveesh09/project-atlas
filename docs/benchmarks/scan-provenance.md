# Scan evidence: functional and offline verifier checks

Recorded 2026-10-29 on the Windows development host; Node 24.22.0, pnpm 10.34.6.
Source base `43b651cf60dfdc88e7abbb0cb7d2501e412c7f59`, with Q2.1 uncommitted.
These are functional observations, not clean-tree release/capacity/device acceptance.

## Cryptographic proof versus orchestration

The actual GitHub CLI **2.102.0** accepts an authentic public fixture from the CLI's
own pinned test corpus. Its signature binds repository `actions/attest-demo`, workflow
`.github/workflows/build-python.yml`, source/signer revision
`a6c23b9806c593664f68637c8f9d45dfcf98b2db`, `refs/heads/main`, GitHub Actions OIDC,
GitHub-hosted runner and SLSA v1. The opaque wheel bytes are never installed, extracted,
imported or executed. See [fixture provenance and license](../../packages/cli/test/fixtures/scan-proof/README.md).

The native Windows physical tests pass both positive and negative cases: changed
subject bytes, wrong workflow digest and wrong source ref fail. Separate adapter tests
use injected verifier responses to check flags, private input copies, environment,
cleanup and fail-closed output handling; these mocks are **not** signature evidence.
Existing `packages/ingest/test/local-git.test.ts` exercises the reused native process
runner's actual deadline, descendant termination, stdout cap and cancellation.

The same production adapter was bundled for an isolated Linux check. The reviewed
Linux GitHub CLI archive is SHA-256 checked before extraction. In the existing
ATLAS-owned image `sha256:ab3276c21b5d79187f0cdaf5e06043a3bb55b60fe49b6b69b27df70843f125c1`,
running as `10001:10001`, Docker uses **network none**, read-only root, no capabilities,
no-new-privileges, 64 PIDs, 512 MiB memory, one CPU and a 64 MiB temporary filesystem.
Only the prepared proof directory is mounted read-only. Real verification succeeds;
tampered subject bytes and a wrong workflow digest fail. No credential or live API is
needed. [Sanitized native result](scan-provenance.json).

The read-only PR workflow repeats real fixture verification in a network namespace.
This is not an ATLAS scan signed by the new producer workflow. That recipe remains
inactive until owner review/merge/dispatch; no live ATLAS scan proof is claimed.

## Producer and viewer

The external example uses explicitly supplied Ruff 0.17.3 against this trusted
repository's one committed Python file, checking its Git blob before and after scanning.
It emits a complete declared scope and exit 0. Nothing executes analyzed Python or
repository configuration; raw SARIF remains ignored local scratch. The declaration
still awaits an external attestation. The CLI's authored two-file fixture separately
tests lint findings, partial scope, invalid blobs, exclusive output and cancellation.

The browser accepts the source-free manifest as an unauthenticated declaration. The
new journey checks profile/scope, preservation of prior state on an invalid blob,
incompatible profiles, clearing, 320 px overflow, accessibility and no uploads. The
captured panel was visually reviewed: scope/profile and the authentication boundary
are readable. This does not replace human or assistive-technology acceptance.

## Failures and corrections

- The first real invocation used both `--signer-repo` and `--signer-workflow`; GitHub
  CLI rejects that combination. The adapter now uses the exact repository-qualified
  workflow plus `--repo`. Real verification passes with that policy.
- Initially the shared process runner threw on GitHub CLI's ordinary failure exit,
  before the adapter could return a controlled error. Known verifier exits are now
  handled explicitly; native faults remain controlled and private. Negative cases
  pass without exposing raw certificate/process diagnostics.
- No assertion, resource cap, production budget or existing test deadline was loosened.

Final verification, cross-browser, distribution and corpus results are recorded in
the dated [implementation status](../implementation-status.md) entry. G6/R6 remains open.
