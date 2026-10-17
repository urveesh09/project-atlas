# ADR-069: Viewer journeys in Firefox and WebKit

Date: 2026-10-17. Status: accepted. Production plan M3.2.

## Evidence and cause

The viewer journeys (`packages/cli/test/viewer.e2e.test.ts`) ran in Chromium only. Running
the whole file in Firefox and WebKit, locally on Windows and then in CI on Ubuntu, found
three product bugs and four test-environment issues.

### Product bugs

1. **Search lost a choice made with Enter.**
   - `Search.tsx` asks a worker for results. When they arrive, it sets results and the
     query they belong to in React state. If Enter came after results arrived but before
     React rendered them, the handler saw the old results. It then recorded a pending
     choice, waiting for a search that had already finished, so nothing was selected.
   - A probe replacing one query with another and pressing Enter failed 5 times in 12 in
     WebKit. It passed every time in Chromium, which happens to render first. A fast
     typist could hit it in any browser.
2. **Safari could not open a picked artifact folder.**
   - The page sends the picked files to the loader worker with `postMessage`.
     `webkitRelativePath` is non-standard, and WebKit's structured clone does not keep it.
   - In the worker, `history/history.json.gz` arrived as `history.json.gz`, so every
     artifact failed with `CHUNK_MISSING`.
   - A probe showed the page itself had all 17 files with correct relative paths.
3. **A blocked eval probe reported as a page error in Firefox.**
   - While defining each object schema, zod checks `Function('')` to decide whether it may
     compile validators.
   - The viewer's CSP (`script-src 'self'`) blocks that, as it should. Browsers already
     validated without compiled code, but Firefox reports the blocked attempt as an error.
   - The probe runs during module evaluation, so setting zod's option from the viewer's
     entry point was too late; the first attempt to do so did not stop the error.

### Test and environment issues

- **`blob:` requests.** WebKit reports `blob:` URLs of the page's own origin as requests.
  They are in-memory objects that never reach a network.
- **Touch gestures.** The touch journey synthesizes pan and pinch through the DevTools
  protocol, which only Chromium has.
- **Firefox on the GPU-less Ubuntu runner.** It had no WebGL2. The viewer correctly fell
  back to the map, but the 3D journey groups could not start.
  - Firefox first blocklisted its software renderer ("AllowWebgl2:false").
  - With `webgl.force-enabled`, it then found no OpenGL driver ("Exhausted GL driver
    options"), because headless Firefox cannot reach Mesa's software OpenGL without a
    display.
- **Two earlier WebKit failures were timing, not WebKit.** The guided-start and comparison
  journeys failed in the first WebKit run but passed in every later run, without any
  change aimed at them. The guided-start one matched bug 1, which explains it.

## Decision

1. **Search reads the newest results.** A ref is written as soon as results arrive, and
   Enter reads it. Results newer than the last render start at their first hit, as a
   render would.
2. **Picked files carry their path.**
   - `apps/web/src/data/picked.ts`: the page sends `{ path, file }` entries, with the
     path taken from `webkitRelativePath` while it still exists.
   - The worker rebuilds `PickedFile`s from those entries.
   - `pickedFilesSource` is unchanged.
3. **Browsers never compile validators.**
   - `packages/schema/src/strict-csp.ts` sets zod's `jitless` mode when it evaluates, in
     browsers only. The schema index imports it first, before any schema is defined.
   - Validation results are identical.
   - Node keeps compiled validators, detected through `globalThis.process`, as in
     `canonical.ts`.
4. **One journey file, any engine.**
   - `ATLAS_E2E_BROWSER` (`chromium` by default, `firefox`, `webkit`) selects the engine.
   - All 40 journeys run in all three engines, rather than the subset the plan proposed.
   - A new journey replaces a query and selects it with Enter six times, guarding bug 1.
5. **Two narrowly scoped test adjustments, with every assertion as strict as before:**
   - same-origin `blob:` URLs count as the page's own;
   - only the pan-and-pinch section of the touch journey runs in Chromium. Firefox and
     WebKit still run its taps, the map fallback, table selection and the layout check.
6. **CI.**
   - A new job, `viewer journeys (firefox|webkit)`, runs on Ubuntu.
   - Firefox runs headed inside Xvfb, with Mesa's software OpenGL installed and its
     software-renderer blocklist overridden. This is the counterpart of Chromium's
     SwiftShader flags. WebKit runs headless and needs nothing.
   - `verify` keeps running the file in Chromium on all three operating systems.

## Not decided here

- **Console noise on fallback.** When WebGL2 is truly unavailable, the viewer falls back
  correctly, but three.js logs context-creation errors on the way. Checking for WebGL2
  before creating the renderer would make that fallback silent. Tracked as production
  plan M3.5.
- **Hosted journeys.** The browser journeys in `apps/worker/test` still use Chromium only.
- **Required checks.** The new jobs become required only when the owner adds them to
  branch protection.

## Verification

- **Probes, against a real served artifact:**
  - query replacement: WebKit 7 of 12 before the fix, then 30 of 30 in each of WebKit,
    Firefox and Chromium afterwards;
  - picked folders: the page had all 17 paths, and the worker lost them before the fix.
- **Unit tests:**
  - `apps/web/test/picked.test.ts` (3): nested chunks found from explicit paths; the
    failure without them; paths from the page or the file name;
  - `packages/schema/test/strict-csp.test.ts` (1): Node keeps compiled validators.
- **Locally on Windows:** all 40 journeys pass in WebKit, Firefox and Chromium, and
  `pnpm verify` passes (799 tests, 83 service-gated skips).
- **CI run 39017637044:** all 15 checks pass. Both new jobs report 40 of 40 journeys and
  no skips.
- **CI history:**
  - run 39016207359 failed Firefox: no WebGL on Linux, so the 3D groups could not start;
  - run 39017032085, with `webgl.force-enabled`, failed with no GL driver;
  - run 39017637044, headed in Xvfb, passed.
