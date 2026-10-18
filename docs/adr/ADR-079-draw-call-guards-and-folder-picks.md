# ADR-079: Draw-call guards per detail level, and folder picks in browser tests

Date: 2026-10-18. Status: proposed; exact-head CI and owner merge required. Supersedes,
for this test only, the single "under 30" draw-call bound recorded in
[ADR-041](ADR-041-living-city.md) §7. The product budgets in the master plan are
unchanged.

## Evidence and cause

Two WebKit journeys failed on #46 and #47. Neither change touches the viewer.

### Draw calls: `expected 30 to be less than 30` (#47, run 39141253002)

**What the test measured.**
- The test reads `drawCalls` from the renderer's last steady frame and required under 30
  for Harbor.
- ADR-041 set that bound for the low-detail scene. CI renders on the CPU, and a
  software renderer whose name reveals it (SwiftShader, llvmpipe, Microsoft Basic) gets
  that scene automatically.

**What WebKit and Firefox actually render.** Measured locally with the real test, three
loads each:

| Engine | Reported renderer | Scene | Steady draw calls |
|---|---|---|---|
| Chromium (CI flags) | `…SwiftShader…` | low detail | 22, 22, 23 |
| WebKit | `Apple GPU` | **full** | 29, **30**, 29 |
| Firefox | `ANGLE (NVIDIA …), or similar` | **full** | 28, 27, 27 |

- **Detection can't fire.** WebKit and Firefox report a masked renderer name, so they
  render the full, animated scene (shadows, trees, clouds, waves). They have done so
  since they joined CI ([ADR-069](ADR-069-firefox-and-webkit-journeys.md)).
- **Full detail moves.** It is animated, and its count changes with what is in view. The
  full-detail scene was always outside the guard's calibration and passed by 0 to 3
  calls. [ADR-039](ADR-039-city-styles.md) and [ADR-040](ADR-040-cinematic-camera-and-atmosphere.md)
  record full-detail counts of 19–38 on real repositories, against the master plan's
  budget of at most 150 (medium default view).
- **The read was sometimes vacuous.** The test read the stats before the first steady
  frame: two of three WebKit reads were **0**, taken while occlusion was still baking.
  `0 < 30` passed without measuring anything.

### Error recovery timed out (#46, run 39141392240)

"Audits malformed and unsupported artifact errors" timed out after 30 s in WebKit. The
retained axe records show it never reached its first audit. It had no bounded steps, so
it reported nothing more.

The closest evidence is this file's earlier WebKit stall
([run 39137944001](https://github.com/urveesh09/project-atlas/actions/runs/39137944001)).
There, `setInputFiles` had not returned after 8 s, although the page already showed
"Validating the selected artifact". The page had the folder; Playwright had not
acknowledged the pick.

Removing a held request there was not the whole cause, since this test holds none. 60
isolated folder picks in WebKit under Playwright 1.64.1's Linux image never stalled, and
the slowest took 0.58 s. So the stall depends on something in the full suite that is not
yet isolated.

### Found while verifying: audits taken mid-animation

Running the whole file repeatedly in Chromium failed **2 of 8** times. The failing test was
"exports the city for 3D printing", at its `share-menu` audit. axe reported
`color-contrast`: a menu button at **2.56:1** (`#9fa2a7` on white).

The share panel fades in from opacity 0 over 0.14 s (`city-menu-in`), and axe includes
opacity when it computes contrast. Audited mid-fade, settled dark text reads as grey. The
race is in the shared `audit()` helper, so it can affect any audit taken just after opening
something. It is not caused by this change.

## Decision

1. **Read draw calls from a steady frame.** The test waits until a frame has been
   drawn, occlusion is not baking, and the camera is not moving.
2. **Guard each detail level by its own documented bound:**
   - **Low detail, under 30, in every engine.** The test turns on the user-facing "Low
     detail" setting and measures. That is the scene the guard was calibrated on, now
     measured the same way everywhere instead of depending on whether the browser reveals
     its GPU.
   - **Default scene, at most 150,** the master plan's budget for a medium default view.

   For WebKit and Firefox's full-detail scene this replaces an undocumented "under 30"
   with the documented budget. It is recorded here rather than presented as unchanged.
   The low-detail guard is applied in more engines than before, and the vacuous read is
   gone.
3. **Folder picks wait for the page, not for Playwright.** In the browser-only journeys a
   pick starts `setInputFiles` and the test then waits, bounded, for the page's response,
   which it asserts as before. Whether the pick returned is recorded and printed with any
   stall.
4. **Every step of the browser-only journeys is bounded at 8 s** and reports the headings,
   status, focus, pick outcomes, recent requests and page errors. A recurrence will say
   where it stopped.
5. **Audits examine the settled page.** `audit()` first waits for running, finite DOM
   animations to finish, bounded at 2 s. Infinite ones, such as spinners, are left running.
   WCAG applies to the settled interface; the rules and their thresholds are unchanged.
6. **No product code changes.** `CityProbe`'s type gains `occlusion`, which the renderer
   already reported.

## Not decided here

- **Making detail adaptive.** Choosing low detail from measured frame times would serve
  users whose browser hides a software renderer, such as Firefox on a GPU-less VM. That is
  a product change with its own UX questions.
- **The suite-level cause of the WebKit pick stall.** It is still unidentified; the bounded
  steps are there to capture it.

## Verification

- **Before the audit fix,** the 48-test journey file failed 2 of 8 Chromium runs, at the
  `share-menu` audit.
- **After all fixes,** it passed 9 of 9 runs locally: Chromium 5/5, WebKit 2/2, Firefox 2/2.
- Probe evidence: the draw-call table above, three loads per engine with the real test,
  and the 60 isolated WebKit picks.
