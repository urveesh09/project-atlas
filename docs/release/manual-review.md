# P6.3: developer and assistive-technology review protocol

Status: **not performed**. No participants, outcomes or manual screen-reader results
are claimed by the automated tests. This is the outstanding plan §1.5 release gate.

## Preparation

Recruit at least five developers unfamiliar with Harbor. Record an anonymous participant
ID, experience, candidate archive SHA-256/source commit, artifact hash, OS/browser and
input method. Obtain consent to record timings and observations; do not record repository
secrets or personal identifiers. Use the same shipped demo and one supported pinned
real repository from [the corpus](real-repositories.md). Start each measured task only
after required artifact chunks load; record loading time separately. Do not coach.

Build the authored demo with `pnpm fixtures:demo --parent <demo-parent-directory>`; analyze
it with the extracted candidate. Use an operator-controlled rehearsal service for the
hosted route, with explicit public-output consent. Absence of an available hosted service
leaves that route untested; it is not a successful local-route substitute.

## Task cards and pass criteria

| Task | Instruction presented to participant | Observable success |
|---|---|---|
| T1 Ingestion | Get a city from the provided local repository, then from the provided public GitHub URL | Correct artifact on both routes, understands public output and completion/partial status |
| T2 Navigation | Find `pricing.ts` in Harbor | Correct file selected in <15 seconds after load, without coaching |
| T3 Dependencies | Find what `pricing.ts` imports and which files import it; show why ATLAS says so | Follows ledger import, identifies incoming consumers, locates import evidence, distinguishes type-only/static relationships |
| T4 Hotspot explanation | Explain why a selected file has a hotspot finding | Uses underlying churn/complexity/fan-in and documented window/threshold, does not infer a defect from color |
| T5 History | Compare Harbor snapshots 5 and 12 and explain additions, deletion and rename | Reports 7 added, 1 deleted, 1 renamed, 4 content changed, 14 unchanged; finds Cargo→Manifest; retains orientation |

Repeat all five tasks using the keyboard and HTML tree/table with 3D unavailable. Ask
participants to identify files/imports/history periods not analyzed in the real corpus.
Explain unsupported transformations only after recording the first unaided outcome.
Record errors, recovery, elapsed time and confusion verbatim without inventing quotes.

Acceptance: at least **4 of 5 successful unaided completions for each task**, including
the keyboard/fallback variant. Treat repeated confusion as a defect, fix it, and repeat
affected tasks. Report the original and follow-up results separately. This is formative,
not a statistically representative study.

## Manual accessibility/device audit

Perform Windows + NVDA + supported Firefox or Chrome, and macOS +
VoiceOver + Safari. Record exact versions and operator. Also run supported Firefox on
the reference integrated-GPU device for the separate performance gates.

| Check | Expected behavior | Result/evidence |
|---|---|---|
| Open/cancel artifact; invalid/truncated input | Named controls, announced progress/error, focus recovery; no upload | Pending |
| Search/tree/table selection | Names, expanded state and current selection announced; no focus trap | Pending |
| Dependencies and findings | Direction, kind, evidence, omitted counts, unknown metrics readable without canvas/color | Pending |
| Timeline/tombstone | Current frame and unavailable/last/next appearance announced; no autoplay | Pending |
| A/B comparison | Direction, ghosts and numerical changes understandable without 3D | Pending |
| Source attachment | Explicit local attachment; historical source matches selected commit | Pending |
| Public submission/cancel/delete/expired result | Public-output notice and errors readable; cancellation/deletion states announced | Pending |
| Reduced motion, 200%/400% zoom, 320 CSS px | Controls reflow; no page-level two-axis scrolling or forced animation | Pending |
| Context loss/3D disabled | Map/tree/table preserve navigation, selection, history and evidence | Pending |
| Focus and contrast | Visible focus; no color-only meaning; no excessive live-region announcements | Pending |

Automated axe/keyboard checks are useful supporting evidence and must not populate
this manual-results column. Keep defects with severity, reproduction, fix commit and
retest evidence. Do not sign off with unresolved P0/P1 defects.

## Screen-reader rehearsal scripts (M3.3)

These are operator instructions, **not completed results**. Rehearse separately from
the five-developer unaided study above: coached rehearsal cannot count as unaided
success. Record each step, actual speech, keyboard focus, outcome and defect. Expected
meanings below are not required word-for-word speech. Record shortcut conflicts and
settings; do not silently use the mouse. Missing devices/services leave steps pending.

Prepare Harbor with history enabled (12 snapshots) and local source attached using
`atlas serve <artifact> --repo <Harbor>`. Also serve the built viewer as static files,
without a bundled demo, for folder-opening checks. Prepare a disposable hosted rehearsal
service. Create an invalid folder containing `manifest.json` with just `{`, and keep a
valid artifact for recovery. Operators may throttle a rehearsal route to make loading
cancellable; record that intervention. Never alter the candidate to simulate a pass.

### Windows: NVDA with Firefox, then Chrome

1. Record Windows/browser/NVDA versions, keyboard layout, modifier and verbosity. Use a
   clean browser profile at 100% zoom. Start NVDA before opening the candidate. Use the
   configured NVDA modifier (Insert or Caps Lock).
2. Use Tab/Shift+Tab through controls and Enter/Space to activate. NVDA+Space switches
   browse/focus mode when arrows need to reach a widget. In browse mode, H navigates
   headings and T tables; Ctrl+Alt+arrows reads table cells with headers. NVDA+Tab reports
   focus. See the [official NVDA reference](https://download.nvaccess.org/documentation/en/keyCommands.html).
3. On the static viewer, reach **Open artifact folder…** by keyboard. Open the native
   folder picker, cancel it, reopen and select valid data. Verify the OS dialog is named
   and navigable. Cancel artifact validation in progress, using recorded throttling if
   needed: identify the landing screen and reach its open control. Open invalid data:
   hear the failure, reach **Open another folder…**, then recover with valid data. No
   stale city may appear during failure.
4. On served Harbor, Tab to **Search files, packages and declarations**. Type
   `pricing.ts`, use arrows through results and Enter to select. Verify path, inspector
   heading and current selection agree. Try a nonexistent query and recover. Do not
   rely solely on `/`, which browse mode may consume.
5. Tab to the repository tree. Send arrows in focus mode: Down moves a row, Right
   expands, Left collapses, Enter selects. Verify level/expanded/selected state. Change
   **View** to the file table; use browse-mode table navigation to read a path and metric
   with headers, then activate a file. Repeat with 2D map or WebGL unavailable: evidence
   must remain reachable without canvas.
6. Reach **Inspector sections**, use Home/Right for **Dependencies**, and read direction,
   static/type-only imports, evidence and unavailable information. Follow the ledger
   import and return by search. Read **Findings** for `router.ts`, including cycle witness,
   policy and limits; expand its disclosures. Open **View source at this line**: verify
   a named read-only dialog, Close control and committed text. Escape must close it and
   return focus to its opener. Block the source request on the rehearsal service and
   verify loading/unavailable status and the same escape route.
7. Reach the current button in **Analyzed snapshots, oldest to newest**. Send Left/Right
   and Home/End in focus mode; hear concise completed-frame status without losing focus.
   Select `legacy.ts` at snapshot 11, then move to 12: read absence and **Last seen**,
   never a replacement file. Follow Manifest/Cargo in **History**. Open **Compare
   snapshots…**, set A=5/B=12 and read direction plus the five T5 counts above from HTML.
   Close comparison; selection and navigation must remain usable.
8. Open **Keys**, **How to read the city**, **How to read history**, Saved views, Scope,
   Bands, Notes and Share individually. Verify expanded state, names and tab order.
   Save/apply/delete a view; mark/remove a note. Set band 3 below band 2: hear the error,
   identify its input and correct it without losing other settings. Export through HTML
   controls; also check the browser/OS download interface manually.
9. **Expand city**, search again, hide/show evidence and leave with Escape. Verify no
   hidden panel traps focus. Enable OS reduced motion: no automatic history playback or
   unnecessary camera flight. At browser zoom 200% and 400%, repeat search, menus, table,
   source and comparison; record CSS viewport width separately. Also inspect 320 CSS px.
   Check clipped controls, page-level sideways scroll and visible focus contrast.
10. On the hosted rehearsal service, read the public-output notice before consenting.
    Submit the authored public repository; inspect queued/running/ready status and
    whether elapsed-time updates drown out reading. Open the result, **Delete…**, read
    the inline confirmation, cancel once, then confirm deletion. Verify recovery from
    the deleted page. In separate runs exercise cancellation, partial, failure/retry,
    expired, unknown and another-session job pages with operator-owned fixtures. Check
    the warning that downloaded copies cannot be recalled. No stale city may be shown.
11. Repeat steps 3–10 in the other Windows browser and log separately. Listen for
    repeated announcements during idle/hover/animation; shortcuts must not steal typing.
    Record every blocked task, recovery and severity. A clean axe report cannot stand
    in for anything heard here.

### macOS: VoiceOver with Safari

1. Record macOS/Safari versions, VoiceOver verbosity, navigation/grouping settings,
   keyboard navigation settings and modifier. Enable Safari's setting allowing Tab to
   reach all webpage controls; record its actual name in that version. Start VoiceOver.
   VO below means the configured modifier, normally Control+Option or Caps Lock
   ([Apple web commands](https://support.apple.com/guide/voiceover/web-commands-vo27972/mac)).
2. Use VO+Right/Left to explore and VO+Space to activate. Use VO+Shift+Down to interact
   with a group/table and VO+Shift+Up to leave it. Also use Tab/Shift+Tab to test keyboard
   focus separately from the VoiceOver cursor. See [Apple's interaction commands](https://support.apple.com/guide/voiceover/cpvokys07/mac)
   for customized keyboards. Avoid leaving Quick Nav consuming arrows while testing
   the tree, inspector tabs and timeline; record the chosen mode.
3. Open rotor menus with VO+U. Left/Right chooses a list, Up/Down an item, Return selects,
   Escape closes without selecting. Check headings, form controls, landmarks and tables
   for a usable outline ([Apple rotor guide](https://support.apple.com/guide/voiceover/mchlp2719/mac)).
4. Perform Windows script steps 3–10 in Safari with these commands and separate results.
   Use Command+A to replace search text. Explicitly test the native folder picker and
   downloaded artifact's nested chunks, source-dialog name/focus return, table headers,
   tree state, sampled history and comparison direction. Keep the same Harbor counts,
   recovery, zoom/reflow and reduced-motion expectations.
5. Read all meaningful evidence with 3D unavailable. Verify both the VoiceOver cursor
   and keyboard focus can leave the canvas and expanded workspace. Record unannounced
   states, duplicate speech, focus jumps and missing information. All manual-result
   cells remain pending until an operator performs the steps.

### Recording and release decision

Attach a sanitized result row per numbered step and platform/browser: candidate commit,
artifact hash, date/settings, actual announcement/focus, outcome, defect and retest.
Playwright WebKit is supporting automation, not a human VoiceOver+Safari session. Inspect
automated `incomplete` rule targets in [the coverage inventory](accessibility-preparation.md).
R6-04 remains open until both manual platform reviews have real evidence and blocking
defects have been corrected.

## Results template

| Participant | Candidate/artifact | Task | Route/view/input | Load ms | Task ms | Unaided success | Error/recovery/observation | Retest commit/outcome |
|---|---|---|---|---:|---:|---|---|---|
| Pending recruitment | | | | | | | | |

Review owner, date and sign-off: **unassigned / pending**. Store sanitized completed
results here or link a review report before marking P6.3 and G6 complete.
