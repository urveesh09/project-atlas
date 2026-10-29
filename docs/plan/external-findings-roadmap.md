# External findings and architecture review

Owner direction: 2026-10-28. This extends the product through ADR-085; it does not
rename or close the original V0.1 release gates. Existing free features remain free.

| Increment | Deliverable | Acceptance boundary |
|---|---|---|
| Q1, merged [PR #52](https://github.com/urveesh09/project-atlas/pull/52) | Local Ruff SARIF import, separate quality contract, snapshot-bound browser evidence and conservative exact-location report comparison | Actual producer fixture, CLI round trip, adversarial input/reference checks, no uploads/source leakage, all browser engines, accessibility and existing CI |
| Q2.1, merged [PR #53](https://github.com/urveesh09/project-atlas/pull/53), ADR-086 | Source-free scan scope/profile evidence, official GitHub CLI offline provenance verification with exact workflow/source/root policy; browser declaration view | Real signed vendor fixture with no network, tamper/wrong-policy rejection, validated partial scope, no browser trust marker. Reviewed signing recipe stays inactive until owner activation; a live ATLAS scan attestation is not yet established |
| Q2.2, this increment, ADR-087 | Context-based tracking inside one history analysis; committed-source review, explicit historical-target/producer policies and browser navigation | Unique unchanged context or identical blob/location retains identity. Duplicate/changed context, changed settings and partial/unverified scope stay uncertain. Comparable authenticated declarations may establish newly/no longer reported evidence, never automatic resolution or a merge verdict. Cross-artifact/long-term issue databases remain future work |
| Q3, future ADR | Production/test dependency policies, package-boundary rules, new-cycle evidence and review/CI reports | Independently authored violation fixtures and exact baselines. Static paths never imply runtime impact or exploitability |
| Q4, future ADR | Private review workspaces, retained baselines, shared decisions and ownership | Pilot teams demonstrate repeated use; tenancy/access/deletion/retention and operating cost are measured before billing |

## Q1's intentional limits

- One producer: Ruff SARIF 2.1.0. Do not claim arbitrary SARIF, SonarQube parity,
  security vulnerability detection, authentic scan provenance or complete scan coverage.
- Customer CI/trusted local tooling produces the report. ATLAS runs no scanner,
  configuration, plugin, tests or fixes, and installs no repository dependencies.
- Reports are separate files; analysis facts/identities and artifact 1.4 remain unchanged.
- Keep rule IDs and bounded locations. Drop source/snippets, original messages, fixes,
  arbitrary properties, links and host paths. Reports are local memory only in the viewer.
- Import/validation errors preserve prior valid reports. Every dropped category is visible.
- Compare exact locations in one analysis and Ruff version. Missing results do not mean
  fixed: moved lines and changed configurations can alter the report independently.
- No private hosted submission, billing, automatic publication or runtime instrumentation.

## Commercial hypothesis to test

The useful workflow is recurring architecture/change review with evidence from the
customer's existing tools. Test task success and repeat use with developers before
building a full scanner platform. Shared history, decisions and automation are future
paid conveniences; current analysis/viewer capabilities remain MIT/free (ADR-048).

Before adding a producer or ruleset, review its exact license and output privacy.
An open engine does not make every compatible rule collection commercially reusable.
Read [the user guide](../guides/external-findings.md) for Q1 commands and limitations.
Read [contextual finding review](../guides/finding-review.md) for Q2.2's exact identity,
source/privacy bounds and the inactive historical producer/signing recipe.
