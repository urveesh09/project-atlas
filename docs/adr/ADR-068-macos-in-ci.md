# ADR-068: macOS in CI

Date: 2026-10-17. Status: accepted. Production plan M3.1. (ADR-067 is reserved by the
shared-dependency-edge-budget work in progress at the time of writing.)

## Evidence and cause

- **macOS had never been tested.** The CLI is offered for macOS, but CI ran on Windows and
  Linux only.
- **The first macOS run** (PR #34, run 39006116424) passed the pinned corpus. The
  three-way determinism comparison matched all six repositories on macOS, Windows and
  Linux, byte for byte. `verify` failed seven tests, none of them in product code:
  - **Six viewer journeys:** wrong file selected. Their tests cleared the search box with
    `Control+A`, which on macOS moves the cursor instead of selecting all. The next query
    was appended to the old text, and the wrong file was chosen. One journey failed only
    because it depended on an earlier one. The viewer already treats Ctrl and Cmd alike.
  - **The CPython oracle:** 2.96% of files parse only in CPython, above its 1% bound.
    - The oracle ran whatever Python each runner had: 3.12.3 on Ubuntu (a distribution
      build of only 574 files), 3.12.10 on Windows and **3.15.0** on macOS.
    - Python 3.15 (released 2026-10) adds lazy imports (PEP 810, `lazy import x`), and its
      own standard library uses them, for example `argparse`, `collections` and
      `dataclasses`. The vendored grammar cannot parse them, so 59 of 2,054 files parse
      only in CPython.
    - This is a real product gap for Python 3.15 code, and it is tracked as its own task.
      The macOS runner only exposed it.
- **The second run** (run 39006853253) fixed those two causes. The oracle used CPython
  3.14.8: 1,863 files parsed by both, the same 3 known grammar gaps, 0 mismatches. Two
  viewer polls still timed out on macOS:
  - the inspector title after a deep link, which passed in runs 1 and 3;
  - paint clearing after a lens change, at the same line in runs 1 to 3.
- **The third run** (run 39007712700, whose macOS `verify` job failed before a newer push
  cancelled the rest of the run) reported the page state when the poll timed out.
  The state was already correct: lens `complexity`, `paint: null`, the 3D city present, no
  page errors. The renderer was SwiftShader (software Vulkan) in lite mode. So on the
  macOS runner the correct state arrives after the poll's default one second.
- **A first fix was not enough.** Waiting for two drawn frames before asserting passed
  once (run 39008158815). The next run, 39008842483, a documentation-only commit, failed
  the same poll. Its page state was again already correct (`paint: null`). The main
  thread is busy with software rendering, which also delays each poll call, so the frame
  wait gave no guarantee. That attempt was removed instead of being kept as an unproven
  fix.
- **Patching one poll at a time did not converge.** With those two polls at 5 s, run
  39009695374 failed the next poll in the same macOS journey: ghost markers clearing
  after a comparison closes. On Ubuntu, a different journey failed: the inspector after
  a search, which had passed in the two previous runs.
  - The file has 60 polls on Vitest's one-second default, each straight after a real
    browser action.
  - The earlier Windows timeouts in implementation status ("M2.3 CI follow-up", runs
    38996642868 and 38998758410) are the same class of failure.

## Decision

1. **The matrices.** `verify` and `pinned repository corpus` run on `ubuntu-latest`,
   `windows-latest` and `macos-latest`.
2. **The determinism job compares all three reports.**
   - `scripts/compare-repository-reports.mjs` takes one report per operating system. It
     still requires Windows and Linux, rejects duplicate or unknown platforms, and names
     both platforms in every mismatch.
   - The job keeps its name, "pinned corpus Windows/Linux determinism", because branch
     protection requires that name. Renaming it would need the owner to update the
     required checks.
3. **One Python for the oracle.**
   - CI's `verify` and the release workflow install CPython 3.14.8 with
     `actions/setup-python` (pinned by commit, v7.0.0), the line ADR-056 validated. They
     pass its path as `ATLAS_ORACLE_PYTHON`.
   - A named interpreter that does not work fails the suite instead of skipping it.
   - Without the variable, local runs discover Python as before.
4. **Cross-platform keys.** Viewer tests select all with `ControlOrMeta+A`.
5. **The browser-journey file polls for up to 5 s.**
   - `packages/cli/test/viewer.e2e.test.ts` sets `vi.setConfig({ expect: { poll: { timeout:
     5_000 } } })`, which applies to that file only. 5 s is the convention the file
     already used for heavy steps.
   - A local probe confirmed the setting takes effect: a state that becomes true after
     2 s fails at 1 s without it, and passes with it.
   - **The assertions are unchanged.** A longer wait cannot make a wrong state pass; it
     only tolerates software rendering's latency.
   - These polls check correctness, not latency. The plan's interaction budgets are
     measured on reference hardware by the benchmark scripts, never on CI's software
     WebGL.
   - The two diagnosed polls report the page state if they time out, so a future failure
     shows what the viewer did instead.
   - The plan's testing rule now states when a longer wait is allowed: evidence that the
     final state is correct, a check that is not a product budget, and a recorded
     reason.
6. **The CLI archive** is created with `COPYFILE_DISABLE=1`, so macOS `tar` adds no
   AppleDouble `._*` entries. Other platforms ignore the variable.

- **Confirmation reruns of run 39010571149.** The macOS and Ubuntu `verify` jobs passed
  again. The Windows rerun failed a different check, not a poll: in the 390 px touch
  layout, the page scrolled sideways just after the inspector opened. That check had
  passed on Windows in every earlier run, and nothing in this change touches it.
  - With no state captured, its cause is unknown.
  - All three sideways-scroll checks now name the widths and the elements that stick out,
    with the assertion unchanged.
  - It is tracked as production plan M3.4. It is not counted as fixed.

## Not decided here

- **Python 3.15 syntax** (lazy imports and anything else new in 3.15) needs grammar
  support and its own ADR. Until then, a 3.15 file using new syntax is a visible parse
  failure, never a silent omission.
- **Required checks.** `verify (macos-latest)` and `pinned repository corpus
  (macos-latest)` become required only when the owner adds them to branch protection.

## Verification

- **Compare script, locally against variants of the committed report:**
  - Windows + Linux + macOS passes, and so does the old Windows + Linux shape.
  - A missing Linux report, a duplicate platform, an unknown platform, a changed digest,
    a missing repository, a non-deterministic repository, the same file twice and a single
    report each fail with a specific message.
- **Oracle:**
  - With `ATLAS_ORACLE_PYTHON` naming CPython 3.14.5 locally, it runs and passes.
  - Naming a missing interpreter fails the suite.
  - Unset, it discovers Python as before.
- **Viewer journeys** pass 39/39 on Windows, also with `CI=1`.
- **CI run 39008158815 (commit 2621814):** all 13 checks pass.
  - `verify` passes on each of Ubuntu, Windows and macOS: 794 tests, 83 service-gated
    skips, and `verify:distribution`.
  - The oracle uses CPython 3.14.8 on all three, with identical results: 1,870 files,
    1,863 parsed by both, the same 3 known grammar gaps and 0 mismatches. Ubuntu
    previously checked only its distribution's 574 files.
  - The determinism job matches all six repositories, five repeats each, on Linux,
    Windows and Darwin.
