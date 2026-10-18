# ADR-071: Silent map fallback when WebGL2 is unavailable

Date: 2026-10-17. Status: accepted. Production plan M3.5; follows ADR-069/070.

Updated: 2026-10-18 with CI failures, diagnostic-read correction and transition contrast.

## Evidence and cause

The existing touch journey disables WebGL and successfully opens the map, then selects
`src/ui/Dock.tsx` through the table. Adding an assertion for both console errors and
uncaught page errors reproduces `THREE.WebGLRenderer: THREE.WebGLRenderer: Error
creating WebGL context.` The renderer catches the exception, but three.js has already
logged it. This is an expected capability limitation, rather than a failed analysis.

The first isolated touch-test invocation timed out because it omitted the earlier
journey that establishes the shared authentication cookie. That is not evidence of a
product failure. Running the whole deep-links group reproduces the actual console
defect above; both original logs remain in ignored scratch.

The 390 px overflow assertion passes during this reproduction. M3.4's previously
recorded intermittent overflow has no identified cause and remains open. No CSS,
overflow assertion, functional deadline or performance budget changes here.

The first CI run, [39057047530](https://github.com/urveesh09/project-atlas/actions/runs/39057047530),
on `01035cc`, failed macOS verification: 809 assertions passed and two failed. Both
disabled-WebGL journeys passed. The first failure was a five-second diagnostic poll
after returning from table to 3D and selecting the complexity lens; the second was
consequent state left by the unclosed comparison. The later failure report shows the
correct complexity lens and null paint. Vitest's error says the callback did not
resolve, not that a wrong value was returned. This run is not counted as passing.

`stats()` queried `getExtension` and `getParameter` on every read, although startup
already queried the same immutable renderer identity. A new browser regression
records both calls before the correction. Such queries can block on graphics work
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices#avoid_blocking_api_calls_in_production)).
The CI report alone cannot distinguish a driver stall from browser/host scheduling;
do not claim that particular cause is proven. The existing mode-switch wait also
tested only publication of the renderer handle, before its first draw.

The follow-up [run 39091246140](https://github.com/urveesh09/project-atlas/actions/runs/39091246140)
on `efe5731` passes macOS verification, including that comparison. Its hosted gate
instead reports 145 passing checks and one `color-contrast` failure on the Analyze
repository button in `hosted-submission-error`: text `#ebedef` on `#407298`, 4.38:1
against the required 4.5:1. Both final palettes are readable, but changing from the
disabled light background/dark text to enabled dark background/light text animates
both colours through unreadable intermediate pairs. The actual shared stylesheet,
paused at fixed transition fractions in a browser, reproduces 1.705:1 at fraction
0.1 in light mode. Preserve that failed log and the hosted audit bundle. Neither
failure is handled by excluding a rule or waiting for the animation to disappear.

## Decision

1. Before each renderer startup, probe WebGL2 on a detached 1 × 1 canvas, using the
   current antialiasing preference and low-power hint. Probe once, not on each frame,
   selection or snapshot change. Do not cache the result across renderer lifetimes:
   availability can change after a graphics failure or a new dataset.
2. A null context or thrown API call uses the existing map/table fallback and its
   explanation. Do not construct three.js's renderer in that case. Keep the existing
   catch for later renderer failures; do not replace console functions or suppress
   real rendering errors.
3. In `finally`, release a successful probe through `WEBGL_lose_context` when available.
   The canvas is never attached or retained. Missing or throwing optional driver
   cleanup does not change the capability result; the canvas remains collectible.
4. Extend the real touch journey with both null-returning and throwing disabled-WebGL
   APIs. Each must try WebGL exactly once, create no three.js canvas, log no console
   errors or uncaught exceptions, and keep the map, table, inspector and narrow-layout
   assertions. Chromium retains its actual synthesized pan/pinch checks. All engines
   retain taps and named accessibility audits.
5. Six focused checks cover successful release, WebGL1-only availability, a throwing
   graphics API, missing extension and both optional cleanup failures. The existing 3D
   journeys guard the normal renderer path. Analyzer, artifact and geometry versions
   and the six-repository analysis baseline are unchanged.
6. Reuse the renderer identity already read at startup, keeping `stats()` free of
   graphics-driver queries. A real-browser regression observes the actual WebGL
   context methods and independently checks that the cached name equals the driver
   result. Before the next lens action, strengthen the existing 3D mode-switch wait
   to require its first draw and the exact comparison's fan-in paint. The subsequent
   five-second lens-state assertion and all comparison counts stay unchanged.
   Keep the original CI log and its accessibility reports, including incomplete
   checkpoints; retest the changed code in every browser and the full suite.
7. Switch a primary action's text and background colours together. Keep its border,
   shadow and press-motion transitions. Existing colours and disabled semantics stay
   unchanged. A real-browser check loads the actual shared stylesheet and measures
   computed colour contrast at seven fixed fractions, in both enabled/disabled
   directions and both themes: 28 readings per engine must each meet 4.5:1. Run the
   actual hosted submission/error journey as well; do not suppress animation in the
   audit or change axe's rules. This corrects a second CI-discovered defect in this PR.

## Verification

The dated M3.5 entry in [implementation status](../implementation-status.md) records
the completed local checks. The pull request's exact-head CI must pass before merge.
R6-01…R6-07 and G6 remain open; automated fallback checks do not establish human
screen-reader usability or reference-device performance.
