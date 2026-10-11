# ATLAS V0.1 candidate verification and distribution

The four product pillars and hosted implementation are available. Phase 6 prepares a
reviewable distribution and release evidence. **G6 is open**; see the [release audit](release-audit.md)
for exact pending human, reference-device and deployment checks. Runtime tracing is deferred.

## Build and extract a portable candidate

Maintainer prerequisites: [locked Node/pnpm/Git toolchain](../toolchain.md). From a fresh checkout:

```sh
pnpm install --frozen-lockfile
pnpm --filter @atlas/web exec playwright install --with-deps chromium
pnpm verify
pnpm verify:distribution
```

The last command builds a portable candidate from already compiled packages and the
production viewer, verifies its relocated extraction, and writes `.atlas-tmp/cli-distribution-result.json`.
That JSON contains the archive path, SHA-256, byte count and source revision. The
[smoke report](distribution-smoke.md) records results. Packaging alone is `pnpm package:cli`.
No registry publication or dependency installation is performed by these packaging steps.

For an end user, extract `atlas-cli-candidate.tar.gz` into a new directory. Install Node
24.15.x and Git ≥2.38 on PATH, then work inside the extracted `atlas-cli` directory:

```sh
node bin/atlas.js doctor
node bin/atlas.js analyze /path/to/repository --out /path/to/atlas-output
node bin/atlas.js verify /path/to/atlas-output
node bin/atlas.js inspect /path/to/atlas-output
node bin/atlas.js serve /path/to/atlas-output --repo /path/to/repository --no-open
```

On Windows quote paths containing spaces and use Windows absolute paths. No pnpm/npm
install is needed for the extracted candidate. Open the **session URL** printed by serve
to authorize the loopback viewer once; do not share that local management link. Subsequent
tabs in the same browser session use its cookie. Stop serve with Ctrl+C.

Analysis reads committed files only, never installs/builds/runs the target repository
and never uploads it. Use `--ref <commit>` for another commit, `--no-history` for HEAD
only, or lower `--history-days`, `--history-commits` and `--snapshots` to reduce scope.
Exit 0 is complete; 2 is a useful partial result requiring coverage inspection; 1 is
failure; 64 is a usage error; 130 is cancellation. [Full CLI contract](../contracts/cli.md).

## Demo and real artifacts

Create Harbor with `pnpm fixtures:demo --parent <demo-parent-directory>` in the maintainer
checkout; the command prints the newly created repository path. Then use the candidate
commands above. Harbor contains a cycle, source/tests,
packages, a hotspot story and a Cargo→Manifest rename across twelve commits. Do not
install or run Harbor's packages. Use snapshots 5 and 12 for the [manual task cards](manual-review.md).
The candidate deliberately omits maintainer fixture tooling.

The [pinned corpus](repository-corpus.json) contains immutable commits for is-plain-obj,
Vue and Vite. Reproduce its source-free artifact exports and independent expectations:

```sh
pnpm build
node scripts/validate-real-repositories.mjs --acquire
node scripts/validate-real-repositories.mjs
```

Only `--acquire` needs network access. Five subsequent analyses per repo are offline.
Artifacts remain in `.atlas-tmp/release-corpus/<owner>-<repo>/artifact`. Serve one with
the candidate without `--repo`, or use the viewer's Open artifact picker. Neither uploads
files. Never package the neighboring `git` directory as an artifact. Read the
[coverage/limitations report](real-repositories.md) before interpreting Vite's partial result.

## Privacy, limits and interpretation

Local source viewing needs an explicit matching repository attachment. Exported artifacts
omit source, author emails and commit messages, but expose paths, names, relationships,
metrics and commit IDs; share deliberately. The hosted route is for **public GitHub roots
only**, requires the public-output notice, and publishes results for seven days. Downloaded
copies cannot be recalled. Hosted storage is private behind visibility/expiry/revocation
checks; the share link is still public. See [operations](../hosted-operations.md) for purge,
restore, rollback and lifecycle behavior.

Limits include 10,000 files/frame, 20,000 union lineages, 200 mainline commits, 12 sampled
frames and 20 MiB compressed artifacts. The artifact schema supports explicit frame
reduction/omissions. Dependencies are static compiler-resolution evidence; generated
outputs, bundler aliases/transforms, nonliteral imports and unsupported assets may be
unresolved/unsupported. Declaration substitution and role heuristics are documented in
[capabilities](../contracts/capabilities.md). Tall/red buildings and hotspots are observations,
not defect diagnoses. Full type checking, runtime traffic, private hosted repos and execution
of repository tests are outside V0.1.

## Hosted candidate rehearsal

Use [hosted development](../hosted-development.md), the [operator runbook](../hosted-operations.md)
and [measured Phase 5 rehearsal](../benchmarks/phase5-rehearsal.md). Each Docker engine
must be dedicated to one service/database; worker startup enforces same-database engine
ownership before reconciliation. Do not advertise a production URL until domain/TLS,
egress firewall, least-privilege roles, expiry/purge, recovery and live canaries are verified
on the intended infrastructure. This candidate does not create public infrastructure.

## Release evidence

[Candidate notes](release-notes.md), [release audit](release-audit.md),
[human-review protocol](manual-review.md), [dependency audit](dependency-audit.md),
[ADR-035](../adr/ADR-035-release-candidate-evidence-and-distribution.md),
[JSON schemas](../../packages/schema/generated), [OpenAPI](../api/openapi.json), [identity](../contracts/identity.md) and
[metrics definitions](../contracts/metrics.md) are the handoff to a reviewer.
