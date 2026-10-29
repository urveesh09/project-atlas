# Scan evidence and GitHub provenance (Q2.1)

This optional CLI workflow binds a producer's declared scan scope/configuration to a
source-free report and verifies who signed those bytes. Analysis stays offline.
It builds on [local Ruff findings](external-findings.md); it does not execute a scanner,
turn report disappearance into resolution, or produce a clean/security/merge verdict.

## Create an evidence file

Start with an `atlas.quality/1` report created against the intended analyzed snapshot.
The external producer supplies two JSON files from its actual successful invocation.
Do not fabricate a file list from the findings: clean files still belong to the scope.

Profile:

```json
{"format":"atlas.ruff-profile/1","isolated":true,"ignoreNoqa":true,"respectGitignore":false,"forceExclude":false,"targetVersion":"py314","rules":["F401","F821"]}
```

Scope (replace the example blob with the actual scanned committed Git blob):

```json
{"format":"atlas.scan-scope/1","files":[{"path":"src/example.py","blobOid":"0123456789012345678901234567890123456789"}]}
```

The producer must use the matching isolated Ruff options, no repository configuration,
no per-file/noqa suppression, no ignore-based exclusions and no `--exit-zero`.
Supply the real Ruff exit code: 0 with no results, or 1 with reported findings. Failure
exit 2 cannot establish completed execution. The producer must confirm scanned bytes
match the declared Git blobs, including after the scan. ATLAS does not observe that
execution; the manifest explicitly calls it **producer-asserted**.

```sh
atlas scan-evidence quality.json --artifact atlas-output --profile profile.json --scope scope.json --exit-code 1 --out scan.json
```

This validates snapshot/file/blob references, rule/profile consistency, result counts
and unique paths. It hashes the normalized profile and writes `atlas.scan/1` exclusively
outside the immutable artifact. Nothing is uploaded. Missing files and dropped records
remain partial; an empty Python scope cannot establish completeness. "Matches analysis"
means the included `.py`/`.pyi` files, **not the entire repository** or analysis-excluded
files. Known counts never substitute for unknown execution.

Limits: 8 MiB evidence/scope/bundle, 10,000 scope files, 64 KiB profile/trust policy,
2 MiB trust root, 1,024 explicit rule codes. Exceeding a cap fails, with no sampling.

## Choose trust independently of the scan

Use the official **GitHub CLI 2.102.0** from its reviewed vendor release. It is an
optional prerequisite for verification, not bundled or installed by ATLAS. Default
locations are the standard host installation directories; `--gh` accepts an explicitly
trusted absolute executable path. Never point it at code from an analyzed repository.

Obtain Sigstore roots explicitly using trusted tooling:

```sh
gh attestation trusted-root > trusted-root.jsonl
```

On Windows PowerShell 5.1, preserve the native UTF-8 bytes with Node rather than its
UTF-16 text redirection (this explicit root acquisition needs network access):

```powershell
node -e "require('node:fs').writeFileSync('trusted-root.jsonl', require('node:child_process').execFileSync('gh', ['attestation', 'trusted-root']))"
```

Review/pin that file's SHA-256 and the exact approved workflow/source revision in a
separate `atlas.scan-trust/1` policy. Do **not** use a policy/root supplied by an untrusted
scan as its own authority. Example values below need replacement with trusted metadata:

```json
{
  "format":"atlas.scan-trust/1",
  "repository":"YOUR_ORG/YOUR_REPO",
  "workflow":".github/workflows/scan.yml",
  "workflowCommit":"0123456789012345678901234567890123456789",
  "sourceCommit":"0123456789012345678901234567890123456789",
  "sourceRef":"refs/heads/main",
  "trustedRootSha256":"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Q2.1 supports a direct workflow in the same source repository and an exact branch ref;
PR refs, broad owner/regex policies, self-hosted runners and alternative OIDC issuers
are rejected. The source commit must match the scan report's analyzed commit. Review
all code and dependencies in the approved workflow; a signature cannot make a compromised
or misleading producer truthful.

## Verify the signature and scope separately

The producer signs the **complete `scan.json` bytes** using a GitHub Actions SLSA v1
artifact attestation. Retain the Sigstore bundle and the matching ATLAS artifact.

```sh
atlas verify-scan scan.json --artifact atlas-output --bundle scan.sigstore.json --policy trust.json --trusted-root trusted-root.jsonl --json
```

ATLAS validates the report against the artifact, pins the root digest, and invokes the
official verifier with exact repository/workflow/digest/source/ref policy. It uses fresh
private copies, a credential/proxy/config-free child environment, no implicit downloads,
a 20-second subprocess deadline and 2 MiB stdout cap. Cancellation kills the process tree.
Malformed/failed output is not exposed verbatim. Verification uses local proof material;
CI exercises real cryptography inside a namespace with no network. UTF-8 evidence must
have no BOM; signed input bytes are never silently rewritten or canonicalized.

Exit 0 means verified provenance plus matching declared analysis scope, **not lint-clean**.
Exit 2 means producer scope is partial/empty or records were dropped; 1 is failure,
64 usage, 130 cancellation. `scan-evidence` uses the same scope/partial distinction but
always reports provenance **unverified** until signing and verification happen.

JSON verification output identifies the evidence/profile digests, source, configured
signer, finding count and scope accounting. Execution remains producer-asserted. This
is a local command result, not a cryptographically reusable browser trust receipt.
The browser opens `quality.json` and `scan.json` locally. A scan manifest shows its
declared file counts, omitted/dropped counts, isolated profile and profile digest,
with an explicit **not authenticated in this browser** warning. Invalid references
preserve prior reports. Two manifests with different profile digests cannot be compared.
It does not accept a copied "verified" JSON field as authentication. Historical
matching remains conservative; no disappearing result becomes resolved.

## Reviewed CI producer example

[The recipe](../examples/scan-attestation.yml) is deliberately outside `.github/workflows`.
An owner must review/copy it to a chosen workflow path, merge it and explicitly dispatch
it from the approved main revision. It is **not activated by this feature**.
The recipe uses pinned actions/tools and
[the external producer script](../../scripts/produce-scan-evidence.mjs), which handles
at most 100 analyzed Python files, checks working bytes against committed blobs before
and after isolated Ruff, and emits source-free evidence. The current example targets
this trusted ATLAS repository, not arbitrary untrusted repositories.

The signing action needs `id-token: write` and `attestations: write`; only scan evidence
and the public signature bundle may be uploaded. Review the public provenance metadata
before dispatch. A live ATLAS scan attestation requires that owner activation; the
shipped physical test instead verifies authentic public vendor fixture material and
must not be described as an ATLAS scan execution proof.

[Decision](../adr/ADR-086-scan-evidence-and-provenance.md).
