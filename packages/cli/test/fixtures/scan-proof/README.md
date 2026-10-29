# Real verifier fixture

Source: GitHub CLI test data at commit `674516ff39ccdaa8a525873f87552609dcda63de`,
`pkg/cmd/attestation/test/data/github_provenance_demo-0.0.12-py3-none-any.whl`
and its `github_provenance_demo-0.0.12-py3-none-any-bundle.jsonl`.
[Upstream](https://github.com/cli/cli/tree/674516ff39ccdaa8a525873f87552609dcda63de/pkg/cmd/attestation/test/data),
[MIT license](https://github.com/cli/cli/blob/674516ff39ccdaa8a525873f87552609dcda63de/LICENSE).
Copyright GitHub, Inc. and contributors; retained as test data under MIT.

The opaque 1,437-byte wheel is stored base64 to preserve exact bytes on all platforms.
It is **never extracted, installed, imported or executed**. Only its digest is checked.
SHA-256: `ae57936def59bc4c75edd3a837d89bcefc6d3a5e31d55a6fa7a71624f92c3c3b`.
The real attestation names `actions/attest-demo`, `.github/workflows/build-python.yml`,
`refs/heads/main` and commit `a6c23b9806c593664f68637c8f9d45dfcf98b2db`.

`trusted-root.jsonl` was explicitly obtained with official GitHub CLI 2.102.0
`gh attestation trusted-root` on 2026-10-28; outer JSON line endings are normalized
to LF. This is public trust material, not a secret or an application default.
Production operators must obtain and pin their own reviewed root and policy; never
copy a trust root or policy from an untrusted scan bundle.

This fixture proves the real crypto adapter and policy enforcement. It is not a
live ATLAS scan attestation and cannot establish that a scanner ran or covered files.
