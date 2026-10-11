# Candidate dependency audit

Recorded 2026-10-11 using the locked pnpm 10.34.6 dependency graph and the configured
registry's advisory endpoint: `pnpm audit --prod --json` and `pnpm audit --json`.

[Raw registry response](dependency-audit.json): 50 production dependencies, zero returned
advisories at every severity. The [full locked dependency response](dependency-audit-all.json)
returns 130 total dependencies and zero advisories, including the non-production scope.
This is a dated advisory lookup, not a guarantee of absence
of vulnerabilities. No source was submitted to the advisory endpoint. Candidate package
inventory and notice text are verified by the [distribution smoke](distribution-smoke.md).

Before public launch, the operator still needs a dated review of the deployed container
image/OS packages, sandbox Git build, trusted tools and actual network firewall. The npm
advisory response does not cover those components. Retain image digests, findings and
resolution evidence in the [release audit](release-audit.md). No unresolved public-launch
security finding may be silently accepted as a successful registry audit.
