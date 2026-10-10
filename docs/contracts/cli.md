# CLI contract

From plan §14. `doctor`, `analyze`, `inspect`, `verify` and `serve` are implemented through P2.6. History options are validated and recorded now and take effect in Phase 4; use `--no-history` for the currently implemented HEAD-only scope.

```sh
atlas doctor
atlas analyze <dir> --out <dir> [--ref <commit-or-simple-ref>] [--history-days 1..90]
              [--history-commits 1..200] [--snapshots 1..12] [--no-history]
              [--previous <artifact-dir>] [--repo-id <uuid>] [--exclude <glob>]...
              [--max-files <n>] [--replace] [--json]
atlas inspect <artifact-dir> [--json] [--no-map]
atlas verify <artifact-dir>
atlas serve <artifact-dir> [--repo <dir>] [--no-open]
```

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

Guarantees, all tested:

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
