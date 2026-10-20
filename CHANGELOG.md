# Changelog

All notable changes to ATLAS. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [semantic versioning](https://semver.org/). Detailed evidence for every
change is in [docs/implementation-status.md](docs/implementation-status.md) and the ADRs.

## [Unreleased]

### Added
- Python 3.15 syntax ([ADR-080](docs/adr/ADR-080-python-3-15-syntax.md)):
  - lazy imports (`lazy import x`, `lazy from x import y`) are found as ordinary imports;
  - unpacking in comprehensions and unary plus in `match` literal patterns parse;
  - the grammar is rebuilt from upstream source plus a recorded patch by
    `scripts/build-python-grammar.mjs`, byte for byte;
  - the CPython parser oracle runs on 3.15.0.
- Python and mixed capacity results ([ADR-081](docs/adr/ADR-081-python-capacity.md)): all
  eight medium/large HEAD and 12-frame history rows pass the unchanged budgets in
  4 CPUs and 2 GiB.

### Changed
- Analyzer `0.1.0-dev.9`: the parser identity records the patched grammar, so analysis
  IDs change. Graph content of the pinned corpus is otherwise unchanged.
- The Python capacity fixture keeps every authored import and imports `typing` only
  where a `TYPE_CHECKING` guard uses it (policy `atlas.capacity.python/2`).

### Fixed
- Package and source dependency edges share the 100,000-edge budget, so a repository
  near the limit gives a partial result instead of failing export
  ([ADR-067](docs/adr/ADR-067-shared-dependency-edge-budget.md)).

## [0.1.0-beta.2] - 2026-10-18

### Added
- Python analysis ([ADR-060](docs/adr/ADR-060-python-integration.md)):
  - `.py` and `.pyi` files are parsed, resolved, measured and checked like TS/JS;
  - Python projects become packages, with their declared PyPI dependencies;
  - mixed TS/JS and Python repositories work, and npm and PyPI packages of the same name
    stay distinct;
  - virtual environments, Python caches and egg metadata are excluded;
  - pallets/flask joins the pinned validation corpus.
- Entry screens and sharing ([ADR-058](docs/adr/ADR-058-interface-polish.md)):
  - the start screen and the hosted landing show a real render of the demo city;
  - page titles name the repository;
  - a description, a favicon, link-preview tags and no-JavaScript text;
  - the demo adds a canonical link, a social card and structured data.
- Python support, part 1 ([ADR-056](docs/adr/ADR-056-python-support-design-and-facts.md)):
  - a Python adapter that extracts imports, declarations, code lines and complexity;
  - checked against CPython's own `ast` on the full standard library, with 0
    mismatches.

  Used by analysis since ADR-060.
- Python support, part 2 ([ADR-057](docs/adr/ADR-057-python-resolution.md)):
  - projects and dependencies from every common Python manifest;
  - import resolution with Python's own precedence.

  Used by analysis since ADR-060.
- 3D-print export ([ADR-055](docs/adr/ADR-055-3d-print-export.md)): coloured 3MF and STL of
  the city shown.
- Package graph view ([ADR-054](docs/adr/ADR-054-package-dependency-view.md)):
  - layered package dependencies, with cycles named and edges that close them flagged;
  - a complete table.
- Annotations ([ADR-053](docs/adr/ADR-053-annotations-and-compact-menus.md)):
  - colour and note on folders and packages;
  - listed in the legend, kept locally, shared as `atlas.notes/1`.
- Metric lenses and bands ([ADR-052](docs/adr/ADR-052-metric-lenses-bands-and-presets.md)):
  - ten colour lenses, including code lines, functions, total complexity, fan-out and lines
    changed;
  - editable band starts with a distribution chart and an even split;
  - seven built-in views.
- Scope ([ADR-051](docs/adr/ADR-051-scope-focus-and-hide.md)): focus on a folder or package
  and hide paths by pattern. Plots stay fixed, every count names what is hidden, and saved
  views keep the scope.
- Change colouring in Compare ([ADR-050](docs/adr/ADR-050-change-colouring-in-compare.md)):
  - colour snapshot B by the signed change of code lines, complexity, fan-in, fan-out or
    hotspot score since A;
  - signed values in the cards and the file table.

### Changed
- Hosted job records are deleted 30 days after the job ends, with their events,
  publication, artifact and upload bookkeeping. Taken-down repositories are kept so their
  takedown keeps applying.
  - The worker runs this through a schema-owned function (migration 3) and still has no
    `DELETE` on jobs.
  - Every page links a required "Service status" page (`ATLAS_STATUS_URL`)
    ([ADR-078](docs/adr/ADR-078-record-retention-and-status.md)).
- The hosted service has privacy, terms and takedown pages and a contact link
  ([ADR-077](docs/adr/ADR-077-public-service-pages.md)).
  - The wording is the owner's plain text.
  - ATLAS adds only labelled facts of what its code does with data.
  - A production API refuses to start without the texts and contact, or with the
    shipped placeholders.
  - New public route: `GET /api/v1/legal`.
- Hosted service levels ([docs/hosted-slo.md](docs/hosted-slo.md),
  [ADR-076](docs/adr/ADR-076-service-levels.md)) are now defined:
  - provisional objectives for publication availability, job success and queue wait;
  - severity levels, first-response steps and how users are told.

  The operator metrics add the 24-hour queue-wait p95 and the API's publication read
  counters. The reference Prometheus loads tested recording rules and objective alerts,
  and keeps 35 days.
- API and sandbox releases now scan the exact OCI archive before publishing, block
  fixable high/critical findings, preserve its pinned-generator SBOM/provenance and
  verify signed release identity. Unused package managers are removed from runtime
  images; build tooling and application dependencies are unchanged
  ([ADR-075](docs/adr/ADR-075-scanned-immutable-image-publication.md)).
- Private daily PostgreSQL backups, independent seven-day expiry cleanup and an
  isolated restore drill now ship with the production reference kit. Restored live
  analyses are quarantined and unfinished work is fenced; lifecycle denials and
  storage isolation are checked against real TLS PostgreSQL
  ([ADR-074](docs/adr/ADR-074-private-backups-and-restore-drill.md)).
- The operator `/metrics` endpoint also answers in Prometheus text format when asked.
  The reference kit adds an optional Prometheus in the API's network namespace, the
  runbook's alerts with promtool unit tests, and an optional Grafana dashboard. The
  operator listener can no longer bind anything but loopback
  ([ADR-073](docs/adr/ADR-073-operator-monitoring.md)).
- Add the M4.1 reference hosted deployment kit: hardened TLS/API profile, worker
  service units, expiring atomic GitHub egress sets, configuration preflight and
  production transport/packet rehearsals. Public deployment acceptance remains open.
- Accessibility audits now inspect open menus, source-dialog states, loading/errors,
  workspace and hosted lifecycle screens in addition to the main views, including
  WCAG 2.1 A rules. CI retains named reports with incomplete checks for human review.
  Step-by-step NVDA and VoiceOver scripts prepare R6-04, which remains open (ADR-070).
- Every viewer journey also runs in Firefox and WebKit, in CI and locally with
  `ATLAS_E2E_BROWSER` ([ADR-069](docs/adr/ADR-069-firefox-and-webkit-journeys.md)).
- CI runs `verify` and the pinned corpus on macOS as well as Windows and Linux. The
  determinism check compares all three ([ADR-068](docs/adr/ADR-068-macos-in-ci.md)).
- CI and the release workflow run the CPython parser oracle against a pinned Python
  3.14.8 instead of each runner's default.

- Upgrade Vitest to 5.0.5, Playwright to 1.64.1 and axe's Playwright adapter to 4.14.0
  while retaining the existing browser and accessibility gates (ADR-061).
- Upgrade runtime contract validation to Zod 4.6.7; generated JSON Schema and OpenAPI
  remain byte-identical (ADR-061).
- Upgrade viewer runtime pins to React/React DOM 19.3.1 and React Three Fiber 9.8.2,
  with its exact-tag distribution license reviewed and refreshed (ADR-061).
- Contract versions ([ADR-060](docs/adr/ADR-060-python-integration.md)): analyzer
  `0.1.0-dev.6`, graph schema `atlas.graph/1.1.0`, artifact `atlas.artifact/1.4.0`. Readers
  still accept artifacts 1.0–1.3. TS/JS results are unchanged at path level; IDs change with
  the analyzer version, as for every version change.
- Summary lines read as sentences, with at most one middle dot; data rows keep their
  separators ([ADR-059](docs/adr/ADR-059-interface-second-pass.md)).
- Interface polish ([ADR-058](docs/adr/ADR-058-interface-polish.md)):
  - self-hosted Geist and Geist Mono outside the city stage;
  - one corner-radius rule;
  - 12 px help text;
  - one label, "Analyze your repository";
  - no dashes in visible text, and "n/a" for unavailable numbers;
  - rule explanations behind "Why this is flagged" in long finding lists.

  The city renders byte-identically.
- Refined controls ([ADR-049](docs/adr/ADR-049-refined-controls-and-icons.md)):
  - one style for buttons, selects and fields in light and dark;
  - switch toggles, menus with icons, and a drawn icon set for the stage controls;
  - history dots no longer sit inside button boxes.

### Fixed
- Devices without WebGL2 now open the map/table fallback without three.js context
  errors. Startup probes release their temporary graphics context; blocked graphics
  APIs that throw also fall back (ADR-071).
- City diagnostics reuse the graphics identity read at startup, so observing a city
  no longer queries the graphics driver during rendering (ADR-071).
- Primary actions switch text/background colours together when enabled or disabled;
  their old colour animation briefly made light-theme text unreadable (ADR-071).
- Cancelling artifact validation stranded keyboard focus on the page body. Landing,
  validation and error transitions now focus their heading once, without interrupting
  progress navigation.
- Package diagram buttons now include their visible file-pair counts in accessible
  names, retaining the full package name when its visual label is shortened.
- City controls and the lens legend now expose named groups; labels on generic
  containers were not reliably available to assistive technology.
- City help sits above the toolbar so an open Share menu cannot leave a partly
  covered, undersized help target (found in Firefox).
- Correct the Harbor 5→12 manual review card: its old counts were for 6→12. An
  independent Git check and a separate table journey cover the intended task; the
  original 6→12 assertions remain intact.
- Search sometimes ignored Enter: if the results arrived just before the key, the choice
  was lost. This was seen in WebKit, and could happen in any browser.
- Safari could not open a picked artifact folder in the browser-only viewer. Every
  attempt failed with `CHUNK_MISSING`, because Safari did not pass the files' folder paths
  to the loader.
- Firefox reported a page error when the viewer's security policy blocked zod's eval
  probe. Browsers now validate without compiling code, with identical results.
- Resolve Python namespace portions only after considering regular packages/modules
  across import roots, and prevent discarded parents from supplying child modules.
  Analyzer `0.1.0-dev.8` deliberately refreshes analysis identities (ADR-066).

- The overview's History coverage showed the raw code for where the window ends, such
  as "days". It now says it in words, worded the same as the timeline and the CLI.
- Failed and cancelled hosted jobs ticked every stage as done, including publishing; they
  now say the run stopped before a result was published
  ([ADR-059](docs/adr/ADR-059-interface-second-pass.md)).
- Package graph nodes were narrower than their counts line.
- The measurements table scrolled sideways in the inspector column.
- Measurements still described the old em-dash placeholder.
- On desktop the page itself scrolled (5,245 px at 1440×900), so a wheel over the header slid
  the explorer away. Hidden tree labels now stay inside their panel
  ([ADR-058](docs/adr/ADR-058-interface-polish.md)).
- The overview's findings stopped at 20 without saying so; every finding is now reachable,
  with the remaining count shown.
- Status pills broke across lines.
- The disabled "Analyze repository" button was hard to read.
- "Open a local artifact folder…" did not look like a button.
- The repository URL placeholder was clipped on phones.
- Primary buttons inside the city had text at 2.27:1 contrast.
- The new city menus had pushed the laptop first screen down 38 px; compact summaries
  restore it.
- An open compare panel covered the city on screens wider than 1350 px.

### Security
- Upgrade `smol-toml` to 1.9.1 to fix quadratic work on untrusted Python manifests
  (GHSA-r4xh-jqrq-34v2). A regression exercises the complete 1 MiB admitted document
  through project discovery, alongside boundary and prototype-like metadata checks.
- Upgrade the supported Node.js runtime and both container bases to 24.22.0
  ([ADR-061](docs/adr/ADR-061-dependency-currency-october-2026.md)). `atlas doctor`
  warns on older 24.x releases without preventing diagnosis. Analysis semantics and
  the pinned built-in module list remain unchanged.

### Maintenance
- Refresh language-support guides, comparison and release/agent handoffs for TS/JS
  and Python, the four-repository corpus and explicitly open Python acceptance work
  (production plan M2.1).
- Upgrade the Python WASM parser runtime to `web-tree-sitter` 0.27.1 with the same
  hash-checked grammar. Analyzer `0.1.0-dev.7` records the new runtime and invalidates
  old analysis identities; the artifact schema stays compatible (ADR-062).
- Pin CI's PostgreSQL service to the reviewed multi-architecture digest already
  used by the development stack. Document monthly workflow-image and exact Git
  package checks, including Debian's security suite (production plan M1.4).

## [0.1.0-beta.1] - 2026-10-14

### Security
- Workspace globs from analyzed repositories are matched without backtracking. A crafted
  glob could stall analysis
  ([ADR-046](docs/adr/ADR-046-security-triage-and-enforced-checks.md)).
- `.git/config` parsing is linear; metadata and static assets are read through one file
  handle.
- Workflow actions are pinned to commit SHAs. `main` requires a pull request and CI;
  secret scanning and push protection are on.

### Added
- Beta 2 first use ([ADR-047](docs/adr/ADR-047-beta-2-activation-workspace-and-release-identity.md)):
  - a guided start with three tasks that name real targets;
  - Expand as a full-screen workspace with search, controls and an evidence panel;
  - *Open on GitHub* links to the exact commit and line for public analyses;
  - PNG exports that carry their provenance inside the file, plus *Export metadata*;
  - a guide, [Analyze your own repository](docs/guides/analyze-your-repository.md).
- Free parity with CodeCharta ([ADR-048](docs/adr/ADR-048-editions-and-free-parity.md),
  [comparison](docs/product/editions-and-comparison.md)):
  - `.gitignore`-style path highlighting with exact counts;
  - saved views with import and export;
  - per-band legend counts;
  - copy image;
  - a Share menu.
- City: keyboard driving (arrows or W A S D, Q/E turn, Shift+arrows tilt, +/− zoom), and
  dependency strokes with arrowheads, rings and direction-marked names on connected files
  ([ADR-045](docs/adr/ADR-045-pointer-picks-keyboard-driving-and-dependency-strokes.md)).
- Release engineering:
  - version-tag releases with the portable CLI archive, checksums and build provenance;
  - API and sandbox images on GHCR;
  - CodeQL, dependency review, OpenSSF Scorecard and Dependabot proposals
    ([ADR-044](docs/adr/ADR-044-release-engineering-and-pilot-readiness.md)).
- A static demo site of the viewer on a verified vuejs/core analysis.
- Security policy, contribution guide, code of conduct, issue forms (including pilot
  feedback) and a pull-request checklist.
- City: wall materials, seeded slab plans and new Modern and Western silhouettes
  ([ADR-043](docs/adr/ADR-043-bake-fallback-proportions-and-materials.md)).
- City: a baked sky-occlusion field, shader paving and glass, priority labels, a selection
  card with a folder trail, Previous/Next view, Expand, Hide tree, and a frame guard with
  calibrated resolution
  ([ADR-042](docs/adr/ADR-042-grounded-city-and-view-controls.md)).
- City: Modern, Eastern-fantasy and Western-fantasy styles, a perspective camera and a
  living sea ([ADR-038](docs/adr/ADR-038-decorative-city-architecture.md) to
  [ADR-041](docs/adr/ADR-041-living-city.md)).

### Changed
- The city takes the first screen. History is a compact strip under it, the long notes
  sit behind *How to read*, and camera buttons are on the stage. On phones the city comes
  before the tree.
- Counts name their units and policies, and a file's findings are split from findings
  about other files.
- Packages are versioned `0.1.0-beta.1`; the viewer shows its version.

### Fixed
- The demo page was 337 px wide on a 320 px screen and clipped a header action.
- 2D map package labels overlapped.
- Clicking a building scrolled the page to the inspector heading (ADR-045).
- After a snapshot change, a failing occlusion worker re-baked the first snapshot
  (ADR-043).
- A selection's deferred focus could take focus back from where the viewer had moved it
  (ADR-041, ADR-042).

## 0.1.0 candidate

The V0.1 release candidate (Phases 1–6) is described in
[docs/release/release-notes.md](docs/release/release-notes.md). It has not been tagged.
