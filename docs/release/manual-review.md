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
| T5 History | Compare Harbor snapshots 5 and 12 and explain additions, deletion and rename | Reports 4 added, 1 deleted, 1 renamed, 4 content changed, 17 unchanged; finds Cargo→Manifest; retains orientation |

Repeat all five tasks using the keyboard and HTML tree/table with 3D unavailable. Ask
participants to identify files/imports/history periods not analyzed in the real corpus.
Explain unsupported transformations only after recording the first unaided outcome.
Record errors, recovery, elapsed time and confusion verbatim without inventing quotes.

Acceptance: at least **4 of 5 successful unaided completions for each task**, including
the keyboard/fallback variant. Treat repeated confusion as a defect, fix it, and repeat
affected tasks. Report the original and follow-up results separately. This is formative,
not a statistically representative study.

## Manual accessibility/device audit

Perform Windows + NVDA + supported Chromium, and a second platform such as macOS +
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

## Results template

| Participant | Candidate/artifact | Task | Route/view/input | Load ms | Task ms | Unaided success | Error/recovery/observation | Retest commit/outcome |
|---|---|---|---|---:|---:|---|---|---|
| Pending recruitment | | | | | | | | |

Review owner, date and sign-off: **unassigned / pending**. Store sanitized completed
results here or link a review report before marking P6.3 and G6 complete.
