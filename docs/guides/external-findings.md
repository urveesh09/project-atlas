# External lint findings

This optional local workflow imports reported lint findings. It runs no scanner,
repository code, plugins, tests or fixes, and uploads nothing. It does not provide
SonarQube parity, vulnerability scanning or a merge-quality verdict (ADR-085).

## Ruff for Python

Use your existing trusted Ruff installation/CI against the **same committed contents**
as an analyzed ATLAS snapshot, from the repository root. Working-tree edits can
invalidate that relationship. ATLAS cannot authenticate Ruff's scanned revision.
For example, in a checkout you control:

```sh
ruff check --isolated --select F401,F821 --output-format sarif --no-cache . > ruff.sarif
```

Ruff exits nonzero on lint errors; that alone does not mean report generation failed.
ATLAS does not execute this command. Version 1 supports one-run **Ruff SARIF 2.1.0**,
physically checked with Ruff 0.17.3. Use relative URIs or local file URIs.
Never install or run an untrusted repository to generate an analysis.

### Bind Ruff SARIF to a snapshot

Obtain a full commit ID from `atlas inspect ./atlas-output --json`. Then:

```sh
atlas findings ./ruff.sarif --artifact ./atlas-output --commit FULL_COMMIT_ID --source-root . --out ./quality.json
```

`--commit` must name an analyzed frame. `--source-root` maps absolute local `file:` URIs
to committed paths; it reads no source. Relative URIs are relative to the repository
root. No basename guessing or remote fetch occurs. Machine paths are not retained.

## ESLint for JavaScript and TypeScript

Run your team's installed ESLint and configured rules in a checkout you trust or
in your own CI. Use the same committed contents as the analyzed snapshot. ESLint
may exit with code 1 and still produce a report containing lint errors. Use its
built-in JSON formatter and get the version from that same installation.

```sh
eslint --version
eslint . --format json --output-file eslint-results.json
atlas findings eslint-results.json --producer eslint --producer-version 10.14.0 --source-root . --artifact ./atlas-output --commit FULL_COMMIT_ID --out ./eslint-quality.json
```

Use your actual ESLint release version and the full commit ID from
`atlas inspect ./atlas-output --json`. The version and commit are operator
declarations. Supply the root as it appears in the report. ATLAS matches local
Windows drive or POSIX paths lexically against that root, and checks the exact
relative path in the artifact. The report can come from another machine if you
provide its original absolute source root.

Supported positions come from `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`,
`.mts`, `.cts` and TypeScript declaration files. Core and scoped plugin rule IDs
are retained when they fit the bounded syntax. Fatal parsing messages and other
records without a supported rule ID count as unsupported. Suppressed findings are
counted separately. The report generated with ESLint 10.14.0 and typescript-eslint
8.72.2 is covered by the integration test. See
[ADR-096](../adr/ADR-096-eslint-external-findings.md).

## Output and exit status

Choose a new output filename **outside** the artifact directory. Existing files are
never overwritten. Core artifacts, hashes, identities and analysis versions stay
unchanged. Sidecars are not in public publications or the server's file inventory.
File mode is 0600 where supported.

Exit 0 means successful import, **not a clean scan**. Exit 2 means records were dropped
(duplicate-only reduction remains 0); 1 is failure, 64 usage and 130 cancellation.
`--json` reports counts/categories. Unsupported positions, unmapped files and suppressed
records are counted. Limits: 8 MiB UTF-8, 20,000 input records and ESLint file records, 4,096 retained findings,
bounded positive positions. Exceeding capacity fails rather than sampling findings.

## Inspect and compare

Open the artifact with `atlas serve` or the browser picker. Choose **External findings
→ Open current quality report…**, and pick `quality.json`. The disposable import worker
checks structure; references are checked against the artifact again. A row selects its
file in the city/tree and opens Findings. No raw message, snippet, fix, arbitrary
property, link or host path is retained/rendered. Rule labels are controlled by ATLAS.
F401 and F821 have friendly labels; other supported rule codes use a generic lint
label. Consult the original trusted scanner output for its full explanation.

![Local quality report on the authored Python fixture](../images/external-quality-local.png)

Reports stay in memory for the artifact session, with at most current and baseline.
Closing the panel preserves them; clearing reports or replacing the artifact discards
them. Failed imports preserve previous reports. A historical report is hidden on
other frames; **Show report snapshot** returns to it. HTML/map/table access needs no GPU.

Import another report using its own full analyzed commit ID and the **same artifact**.
Open it with **Open baseline quality report…**, or use:

```sh
atlas findings ./ruff-new.sarif --artifact ./atlas-output --commit FULL_NEW_COMMIT_ID --out ./quality-new.json --baseline ./quality-old.json
```

Comparison needs the same analysis, producer and version. It matches rule, lineage, line and
column. Labels are **newly reported**, **no longer reported** and **at the same location**.
Line movement can create unmatched locations on both sides; severity can change at a
matched location. Commit binding is user-declared; scope/configuration are unverified.
Zero or disappearing results never establish clean coverage, safety or resolution.

For Ruff scope/profile declarations and separate offline GitHub signature checks,
see [scan evidence and provenance](scan-provenance.md) (Q2.1). Plain quality reports keep
the limitations above; browser declarations remain unauthenticated.
For source-backed Ruff tracking through line shifts and renames, use
[contextual finding review](finding-review.md) within one history artifact. It keeps
uncertain evidence unmatched and never turns disappearance into a resolved verdict.
