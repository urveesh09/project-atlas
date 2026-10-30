# CLI contract

Q3's [architecture review contract](../guides/architecture-review.md) and ADR-089 add
`review-architecture`. It reads only validated artifact data and an explicit JSON
policy. Exclusive sidecar output is JSON by default or Markdown with `--markdown`.
Default review mode returns 0/2 for complete/incomplete evidence; opt-in
`--fail-on new|all` returns **3** for observed blocking policy matches, including when
coverage is partial. `new` requires an earlier baseline. Errors/usage/cancellation
remain 1/64/130. This is not an authenticated security or merge-approval verdict.

From plan §14. `doctor`, `analyze`, `inspect`, `verify` and `serve` are implemented through P2.6. History options take effect and history is on by default. `--no-history` explicitly disables only history. Inspect reports the requested/observed window, frame selection, lineage and history availability; verification streams every frame. Serve verifies source attachment for every declared historical frame.

The optional `findings` extension is specified separately below (ADR-085); its import
verdict, exit codes and exclusive sidecar output differ from analysis output.

```sh
atlas doctor
atlas analyze <dir> --out <dir> [--ref <commit-or-simple-ref>] [--history-days 1..90]
              [--history-commits 1..200] [--snapshots 1..12] [--no-history]
              [--previous <artifact-dir>] [--repo-id <uuid>] [--exclude <glob>]...
              [--max-files <n>] [--replace] [--json]
atlas inspect <artifact-dir> [--json] [--no-map]
atlas verify <artifact-dir>
atlas serve <artifact-dir> [--repo <dir>] [--no-open]
atlas findings <ruff.sarif> --artifact <dir> --commit <full-oid> --out <quality.json>
               [--source-root <dir>] [--baseline <quality.json>] [--json]
atlas review-architecture <artifact-dir> --policy <policy.json> --commit <full-oid>
               --out <review.json> [--baseline <earlier-full-oid>] [--markdown]
               [--fail-on new|all] [--json]
```

`doctor` requires the Node 24 major and recommends at least 24.22.1, matching the
workspace engine minimum. Older 24.x runtimes produce a `warn` check and an upgrade
message, but warnings alone leave `ok: true` and exit code 0. Other major versions
produce a `fail` check and exit code 1. JSON check statuses are `ok`, `warn`, `fail`
or `info`; human output distinguishes warnings from passed checks.

| Exit code | Meaning |
|---|---|
| 0 | The requested supported scope is complete |
| 2 | Useful partial artifact (limits, parse failures, partial history) |
| 1 | Analysis or validation failure |
| 64 | Command or argument error |
| 130 | Cancelled (SIGINT); staging removed and any existing output left intact |

Output layout:

```text
<out>/manifest.json            validated manifest (written last)
<out>/graphs/<snapshot>.json.gz
<out>/history/history.json.gz
<out>/layout/layout.json.gz
<out>/summary.json             derived, optional for import
<out>/repository-id.json       local identity, reused by later runs
```

With `--json`, `analyze` writes NDJSON events to stdout (`start`, `progress`, `result` or `error`); human progress goes to stderr. `NO_COLOR` and non-TTY output are plain text; `ATLAS_ASCII=1` avoids Unicode glyphs.

Artifact-analysis guarantees, all tested:

- `--ref` accepts only a full commit ID or a simple ref name (`isSimpleRefName`). Revision expressions and option-like values are rejected with `REF_INVALID`.
- Only committed objects are read. Working-tree edits and untracked files are invisible, which is tested.
- No network access: the offline reader allows no transport protocol and sets `GIT_NO_LAZY_FETCH`. The CLI test traps sockets and records zero attempts.
- The analyzed repository's `.git` directory is byte-identical before and after.
- Output is staged beside the target and swapped in atomically. A non-empty output is replaced only with `--replace`, only when it is already an ATLAS artifact, and never when it is the repository or one of its parents. Interrupted writes are recovered on the next run.

## Local browser viewer

Build viewer assets with `pnpm build:web` before `atlas serve`. The server binds an OS-selected loopback port, validates Host/Origin, exchanges a single-use session capability for an HttpOnly cookie, serves only manifest-listed artifact chunks and bundled assets, and blocks path traversal/unlisted files. The bootstrap capability is cleared from browser state after exchange. With `--no-open`, use the printed session link manually.

`--repo` attaches committed source explicitly. The server validates the artifact's selected commit and each requested path/blob pair against that repository before returning bounded read-only text. Missing/wrong source never disables graph inspection. No arbitrary path, revision or blob endpoint exists. Without an attachment, source is unavailable with a reason.

Artifact 1.1 graph chunks use the lossless indexed encoding in [ADR-018](../adr/ADR-018-indexed-graph-transport.md); CLI/browser consumers also read plain 1.0 chunks. Chunk hashes still verify full canonical decoded graphs. The browser's local file picker validates inside a worker and sends no artifact data to any server.

Phase 3 writers emit artifact 1.2; readers accept 1.0/1.1/1.2 with a 128 MiB cumulative decoded cap and unchanged 20 MiB compressed cap. Limits reject oversized exports rather than dropping graph evidence. See [ADR-024](../adr/ADR-024-decoded-artifact-capacity.md).

The same `serve` command now opens the production city. Choose 3D, map or paged file table; search/tree/inspector share selection. Selecting a file leaves the camera unchanged; Focus selection and reset/zoom/north controls explicitly move it. View fragments accept only validated frame, file lineage, lens, mode and inspector tab fields, bounded to 4 KiB. Loading another artifact cancels the previous validation and disposes its query worker.

Structure, maximum complexity and fan-in lenses retain raw metrics and a visible legend. Incoming/outgoing dependency lists expose omitted arcs and support pinning; static reachability has explicit limits. The full external-package list remains available beyond the 50-terminal display cap. WebGL failure falls back to map; all graph tasks remain available through semantic HTML when canvas is unavailable.

Image export is bounded to 2048×2048 and at most 4 million pixels. The PNG is accompanied by JSON identifying commit, analysis, layout/version, selection, lens, filters, edge limits and camera. Export does not upload data or embed source. Browser file import likewise stays local.


## External quality reports (ADR-085)

`atlas findings <ruff.sarif> --artifact <dir> --commit <full-oid> --out <file>` imports
one-run Ruff SARIF 2.1.0. Optional `--source-root <dir>` maps absolute file URIs;
`--baseline <quality.json>` compares exact locations in the same analysis/Ruff version.
No scanner executes. The separate `atlas.quality/1` sidecar binds an analyzed snapshot,
with user-declared commit provenance and unverified scan scope. Nothing is uploaded.
Output must be new and outside the artifact (including resolved parent aliases).
Exit 0 is a successful import, not a clean scan; 2 means dropped records (duplicates
alone stay 0); 1 is failure, 64 usage, 130 cancelled. Read the
[guide](../guides/external-findings.md) for limits, privacy and interpretation.

## Scan evidence and provenance (ADR-086)

```sh
atlas scan-evidence quality.json --artifact <dir> --profile profile.json --scope scope.json --exit-code 0|1 --out scan.json [--json]
atlas verify-scan scan.json --artifact <dir> --bundle bundle.json --policy trust.json --trusted-root root.json [--gh <absolute-executable>] [--json]
```

`scan-evidence` validates a separate `atlas.scan/1` manifest: the existing quality
report, explicit isolated Ruff profile, unique path/blob scope and producer-asserted
execution. Output must be new and outside the artifact. It runs no scanner and reports
provenance as unverified. `verify-scan` independently validates artifact binding and
invokes the official GitHub CLI 2.102.0 against private copies of local proof material.
The operator selects the exact repository/workflow revision, source commit/ref and
SHA-256-pinned root; no report-supplied policy becomes its own authority. The verifier
has a minimal credential/proxy/config-free environment, a 20-second process deadline,
2 MiB stdout limit and tree cancellation. No implicit download or upload is added.

Both commands exit 2 for partial/empty declared Python scope or dropped records, 1 for
failure, 64 for usage and 130 for cancellation. Exit 0 means matching declared analysis
scope; only `verify-scan` additionally authenticates provenance. It never means lint-clean,
complete repository scanning, resolved issues or a merge verdict. JSON output preserves
the producer-asserted execution boundary. It is not a reusable browser trust receipt.
See the [guide](../guides/scan-provenance.md) for exact schemas, caps and the inactive
owner-reviewed signing example.

## Contextual finding review (ADR-087)

```sh
atlas review-findings current.scan.json --baseline old.scan.json --artifact <dir> --repo <dir> --out review.json [--json]
  [--current-proof <dir> --baseline-proof <dir> [--gh <absolute-executable>]]
```

Both scans must belong to different ordered frames of one history analysis. Read only
committed Git objects; verify real ancestry, frame inventories and read blob hashes.
No source checkout, config execution, scanner or network. Unique exact code context
retains a tracking ID across moved lines/accepted renames; ambiguous/changed/unavailable
context uses unchanged-blob location identity or stays unmatched. IDs are bounded to
the analysis's lineage window, not permanent cross-artifact issue identity.

Output `atlas.finding-review/1` is exclusive and outside the artifact, capped at 8 MiB,
source-free and independently validated on opening. Optional proof directories each
contain `bundle.jsonl`, `trust.json`, `trusted-root.jsonl`; both or neither are required.
Legacy direct policies retain source/scan equality. Explicit `atlas.review-scan-trust/1`
policies independently pin the historical scan commit and attested producer source/
workflow/root, enabling a current producer to scan historical objects. See the
[guide](../guides/finding-review.md) for the exact policy format and verification limits.

Exit 0 means comparable authenticated declarations without unmatched rows, even when
findings remain; 2 means useful uncertainty/unsigned scope, 1 failure, 64 usage, 130
cancelled. Newly/no longer reported accounting never establishes a fix or merge verdict.
The browser always treats stored verification claims as unauthenticated declarations.
Importing a review atomically replaces both reports; invalid imports preserve previous
state. Individual report import, clear, reload and dataset replacement clear the review.
