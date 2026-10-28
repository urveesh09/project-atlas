# External quality: functional producer and browser checks

Recorded 2026-10-28 on the Windows development host, Node 24.22.0/pnpm 10.34.6.
Source base `544b56c6d0f20506946b2b0070f916e43d880e70`, with the feature uncommitted.
These are functional observations, not a clean-tree release/capacity/device benchmark.

## Actual producer

The official Ruff 0.17.3 Windows archive matches SHA-256
`a84d9ac74af8ef5bac84a1888a1634df18e6e985e2f930d35c052beacd00e813`.
The independently authored fixture is `import os` followed by `print(missing)`.
`ruff check --isolated --select F401,F821 --output-format sarif --no-cache sample.py`
reports exactly the expected F401 at 1:8 and F821 at 2:7; exit 1 means lint findings.

The CLI imports the original absolute-URI report using an explicit source root and
analyzed commit. Import exits 0 and both positions survive; all artifact file hashes
remain unchanged. The sidecar contains no original message, snippet or machine path.
See [the sanitized result](external-quality-import.json) and
[fixture provenance](../../packages/graph/test/fixtures/README.md).

## Failures retained and explained

- The first new Chromium journey compared mixed-case `innerText` with a heading that
  existing CSS uppercases. It now asserts the named accessible heading and its
  visibility; the required evidence remains identical. The focused retest passes.
- The first full WebKit run passed 49 of 50 journeys. The new no-upload assertion used
  a URL prefix and rejected local `blob:` reads. Captured events show GET-only `http:`
  and `blob:` requests with the same loopback origin. The test now compares parsed
  origins and still rejects every non-GET request and foreign origin. The full WebKit
  retest passes 50/50. No application upload, deadline change or budget relaxation.

Full Firefox and WebKit runs pass all 50 journeys. Following the keyboard-focus
refinement, both new journeys pass again in each engine. Automated new journeys cover
local/no-upload import, reference errors preserving prior evidence, frame changes,
comparison caveats, cancellation/recovery/reload, 320/390 px overflow and accessibility.
The screenshot was visually inspected. Additional interactive Work-browser use was
unavailable because it is disabled in Work settings; no human acceptance is claimed.

The final suite, baseline, distribution and CI evidence belong to the dated
[implementation status](../implementation-status.md) entry. None closes G6/R6.
