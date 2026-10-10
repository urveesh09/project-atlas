# CLI contract

From plan §14. `doctor`, `analyze`, `inspect` and `verify` are implemented (P1.5); `serve` arrives with the functional viewer (P2.6). History options are validated and recorded now and take effect in Phase 4.

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
