# CLI contract (initial; implemented in P1.5 and P2.6)

From plan §14. Nothing here ships in Phase 0; it is the specification the CLI tasks build against.

```sh
atlas doctor
atlas analyze <dir> --out <dir> [--ref <commit-or-simple-ref>] [--history-days 1..90]
              [--history-commits 1..200] [--snapshots 1..12] [--no-history]
              [--previous <artifact-dir>] [--repo-id <uuid>] [--replace] [--json]
atlas inspect <artifact-dir> [--json]
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

Properties already enforced by Phase 0 code that the CLI will rely on:

- `--ref` accepts only a full commit ID or a simple ref name (`isSimpleRefName`). Revision expressions and option-like values are rejected with `REF_INVALID`.
- Only committed objects are read. Working-tree edits and untracked files are invisible, which is tested.
- No network access: the offline reader allows no transport protocol and sets `GIT_NO_LAZY_FETCH`.
