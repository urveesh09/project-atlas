# ADR-071: Silent map fallback when WebGL2 is unavailable

Date: 2026-10-17. Status: accepted. Production plan M3.5; follows ADR-069/070.

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

## Verification

The dated M3.5 entry in [implementation status](../implementation-status.md) records
the completed local checks. The pull request's exact-head CI must pass before merge.
R6-01…R6-07 and G6 remain open; automated fallback checks do not establish human
screen-reader usability or reference-device performance.
