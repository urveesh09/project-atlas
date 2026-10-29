# Review architecture dependencies offline

Q3 adds declared architecture rules over an existing, validated ATLAS artifact.
It reads no repository, invokes no Git/scanner/plugin and makes no network requests.
The artifact and analyzer outputs remain unchanged. Nothing is uploaded.

## Define a policy

Save an operator-reviewed file, for example `architecture-policy.json`:

```json
{
  "format": "atlas.architecture-policy/1",
  "rules": [
    {
      "id": "production-does-not-import-tests",
      "kind": "forbidden-dependency",
      "from": { "roles": ["source", "declaration"] },
      "to": { "roles": ["test"] },
      "edgeKinds": ["imports-value", "imports-type", "reexports-value", "reexports-type", "requires-literal", "imports-dynamic-literal"]
    },
    {
      "id": "web-does-not-import-api",
      "kind": "forbidden-dependency",
      "from": { "packages": ["apps/web"] },
      "to": { "packages": ["apps/api"] },
      "edgeKinds": ["imports-value", "imports-type", "reexports-value", "reexports-type", "requires-literal", "imports-dynamic-literal"]
    },
    { "id": "static-value-cycles", "kind": "cycle" }
  ]
}
```

Replace package paths with the owning package paths in **your** analysis. They are
exact paths to the package directory, not npm/PyPI names or directory prefixes.
An empty package path `""` means the root package. Each file has one owning package.

Selectors support `paths`, `roles`, and `packages`. Fields combine with **AND**;
values inside one field combine with **OR**. Omitted fields are unrestricted.
Every selector must contain at least one nonempty array. For example:

```json
{ "paths": ["apps/web/src"], "roles": ["source"], "packages": ["apps/web"] }
```

`paths` match the exact path or descendants across `/` segment boundaries:
`src` matches `src/main.ts`, never `src-old/main.ts`. `""` means all included paths.
Paths preserve case and Unicode and use `/`, including on Windows. These are
literal values, not globs or regular expressions. `roles` use ATLAS's recorded
classification: source, test, declaration, config, asset, opaque. Select paths
explicitly when your team's production/test boundary differs from that classification.

The policy selects file-to-file edges only. Names for `edgeKinds` are
`imports-value`, `imports-type`, `reexports-value`, `reexports-type`,
`imports-dynamic-literal`, `requires-literal`, `imports-resource`.
Every confidence level is included and each retained edge names its confidence.
External packages, declared manifest dependencies and project references are not
evaluated by these rules. Unresolved imports cannot supply a target; coverage says so.

Policies are never discovered or executed from analyzed repositories. Rules are
sorted by ID; selector values and kinds are sorted before hashing, so input order
does not change policy identity. Duplicate IDs/values/JSON keys, escaped duplicate
keys, unknown fields, invalid paths and more than 32 nesting levels are rejected.
Limit: 64 KiB, 16 rules, 32 values per selector field, one cycle rule.

## Generate JSON and readable reports

Use full commit IDs listed in the artifact's `manifest.json`. Both commits must be
completed frames in the same artifact; the baseline must be earlier in frame order.

```sh
atlas review-architecture atlas-output --policy architecture-policy.json \
  --commit FULL_CURRENT_OID --baseline FULL_BASELINE_OID --out architecture-review.json --json

atlas review-architecture atlas-output --policy architecture-policy.json \
  --commit FULL_CURRENT_OID --baseline FULL_BASELINE_OID --out architecture-review.md --markdown
```

On PowerShell, put each invocation on one line or use its backtick line continuation.
Output paths must be outside the artifact and must not exist. Creation is exclusive
(mode 0600 where supported); a failure never truncates a prior report. Output may
not exceed 8 MiB. `--json` controls standard output's summary, independently of the
report format selected by `--markdown`.

Without `--baseline`, current matches are **uncompared**. With a baseline, each
current relation is **continuing** or **newly observed**. Summaries also count
baseline relations **no longer observed**; absence never means resolved.

Relation identity uses bounded source/target lineages, edge kind and confidence.
Accepted renames retain continuity; delete/recreate and copies do not. IDs are scoped
to one analysis and policy hash, not a permanent cross-analysis issue database.
Changing the selected policy evaluates both snapshots again under that same policy.

Cycles use the existing synchronous static value/re-export/require policy, excluding
type-only, dynamic and resource imports. A cycle rule reports strongly connected
**components**, including self edges. The same member lineages remain a continuing
component even if a new route appears inside it. This does **not** enumerate every
simple cycle or detect every newly introduced cycle path. Components with changed
membership are newly observed. A missing/too-long closed witness is named unavailable;
a truncated path is never displayed as a complete cycle.

## Evidence and incomplete evaluation

JSON includes the normalized policy and SHA-256, analysis/repository/snapshot/commit
identities, both coverage records, per-rule selector match counts and relation counts,
and bounded current evidence. Each dependency carries file paths/roles/package paths,
lineages, node/edge/observation IDs, confidence and statement locations. It excludes
source snippets, import specifiers, commit messages, authors and absolute host paths.
Markdown escapes input punctuation so paths cannot become active HTML or links.
Reports contain repository metadata; choose sharing recipients accordingly.

All rule matches are counted, even when only 2,000 rows can be retained. Retention is
deterministic, in normalized rule order and edge/component order, then rows sort by ID.
An edge keeps at most four statement locations; a cycle lists at most 32 members and
64 witness hops. Each omission is counted. Partial graph coverage, missing selectors,
missing lineage and truncated report/cycle evidence produce explicit reason codes.
Known violations can still block a requested policy check while evidence is partial.

The scope is **observed internal file dependencies**, not every dependency of every
language in a repository. Opaque files have no extracted imports; their counts remain
visible in coverage. Exclusions, unresolved/unsupported imports, parse failures,
limits and other graph coverage warnings prevent a complete evaluation. Even a
complete evaluation says nothing about security, runtime reachability or exploitability.
Artifact hashes establish integrity; this command does not authenticate its producer.
Stored reports are declarations, not reusable trust receipts. The library's
`validateArchitectureReview` recomputes a JSON review from its matching artifact frames.

## Explicit CI policy checks

Default mode is a review report. It does not fail merely because it found a policy
match. Add `--fail-on new` or `--fail-on all` deliberately in your trusted CI:

```sh
atlas review-architecture atlas-output --policy architecture-policy.json \
  --commit FULL_CURRENT_OID --baseline FULL_BASELINE_OID \
  --out architecture-review.json --fail-on new --json
```

| Exit | Meaning |
|---|---|
| 0 | Complete evaluation within declared graph scope, with no match blocking the chosen mode |
| 2 | Incomplete evidence, without an observed match blocking the chosen mode |
| 3 | Observed violations block the explicitly requested `new` or `all` policy, even if evidence is partial |
| 1 | Read, validation, capacity or output failure |
| 64 | Invalid command, commit selection or arguments; `new` requires a baseline |
| 130 | Cancelled |

Keep the report on all exits. Check exit codes, not merely JSON `ok`: `ok: true`
means the report was produced, while `policyBlocked` explains exit 3. Generate the
artifact in your trusted CI, pin its intended commits, and review the policy itself
as code. This tool never edits GitHub rulesets or grants merge/security approval.

Interactive city overlays/import, persistent reviews, private hosting and billing are
later work. Current free features remain free. See [ADR-089](../adr/ADR-089-offline-architecture-review.md),
the [roadmap](../plan/external-findings-roadmap.md) and the [release audit](../release/release-audit.md).
