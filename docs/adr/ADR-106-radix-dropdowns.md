# ADR-106: Radix UI dropdowns

Date: 2026-11-21. Status: accepted for the viewer.

## Evidence and cause

The owner asked, on 2026-11-21, for a more refined interface to help sell ATLAS, naming the
dropdowns as the part that looked basic and asking about MUI or a similar well-known free
library. The viewer had 19 native `<select>` elements (city toolbar, inspector, compare,
finding and architecture review). Their trigger already used the control tokens
(ADR-049), but the open list is drawn by the operating system: a plain system menu that
ignores the theme, shows no grouping beyond `<optgroup>` text and looks different on
every platform.

## Decision

- Use **Radix UI Primitives** (`@radix-ui/react-select` 2.4.1, MIT, published 2026-10-12),
  not MUI. Radix supplies the behaviour (focus, keyboard navigation, type-ahead,
  collision-aware positioning, screen-reader semantics) and no styling, so the viewer keeps
  its own design system instead of adopting Material Design, and adds no CSS-in-JS runtime.
  It is the base that shadcn/ui builds on. Its 38 transitive packages are MIT, apart from
  `tslib` (0BSD); none is on the CI licence deny list.
- One `Select` component (`apps/web/src/components/Select.tsx`) replaces all 19. The trigger
  is a `combobox` button named by `aria-label` (matching the visible label) or a `<label>`,
  drawn exactly like the other controls. The list is a floating panel on the menu surface:
  soft shadow, a short open animation (none under reduced motion), highlighted row, a check
  on the current choice, uppercase group headings (the Lens list), disabled choices and
  scroll arrows. Light and dark follow the existing tokens.
- The trigger and every choice carry `data-value`. Tests and audits pick and read choices by
  value through two helpers (`chooseOption`, `valueOf`) in place of Playwright's
  `selectOption` and `inputValue`, which only work on native selects. Every assertion is
  unchanged.
- An empty value (the architecture rule filter's "All rules", where a real rule may be named
  `all`) maps to an internal sentinel, because Radix reserves the empty string.
- Closing a list hands focus back to its trigger, but Radix does that a task later. In CI
  (run on commit eeae327) a decision chosen in one dropdown opened the draft editor, the
  editor focused its own first field, and the late hand-back pulled focus away again,
  failing the keyboard journey that expects focus in the editor. The trigger now takes
  focus back only if nothing else has taken it meanwhile; after a mouse choice, a keyboard
  choice and Escape, focus still lands on the trigger.
- The list panel may grow to 520 px (or the space available), so the grouped Lens list
  (about 460 px) opens without scrolling. In CI Firefox (same run) a journey choosing a
  lens near the end of the then-scrolling list timed out once; longer lists still scroll,
  with arrows, and the test helper brings a choice into view before clicking it.
- The CLI distribution ships every runtime dependency's license text. One new transitive
  package, `react-remove-scroll-bar@2.3.8` (MIT), was published without a license file, so
  `pnpm verify:distribution` stopped on it in CI (macOS). As for `@react-three/fiber@9.8.2`,
  the packager supplies the author's MIT text for that exact version from
  `docs/release/licenses`, pinned to the upstream Git blob.
- The distribution smoke test (`scripts/verify-cli-package.mjs`) and the demo-site deploy
  check (`scripts/check-demo-site.mjs`) picked choices with `selectOption`; they now open
  the dropdown and pick by value, like the journeys.
- Native checkboxes, buttons, text fields and the existing `<details>` menus are unchanged,
  with one fix found while reviewing them: the city card clips its overflow, so at a
  1440 px window the Notes menu was cut off at the card's right edge. A menu that would
  cross either edge of the card now slides sideways just far enough to fit
  (`placeOpenMenus`). It is placed when it opens (on the `open` attribute's mutation,
  before the first paint), after every render of the city and when the card resizes.
  The first version decided once, at open, between left and right alignment; in CI
  (run 44882490190) a saved view then switched the view mode, the toolbar rewrapped, and
  the Saved views menu was left off the card under the repository tree, so its Export
  button could not be clicked. Checked afterwards at 1100–1440 px for the scope, saved
  and notes menus across the 3D, table and map views: every menu stays inside the card.

## Verification

- `pnpm verify` with required browser tests on Windows, 2026-11-21: 99 test files passed,
  6 skipped; 1128 tests passed, 95 skipped. That includes all 64 Chromium viewer journeys,
  which pick every dropdown through `chooseOption`, and their axe accessibility audits.
- Light and dark captures of the city toolbar with the View and Lens lists open; the
  four city menus captured open at a 1440 px window, Notes now inside the card.
- Firefox and WebKit journeys run in CI only.
