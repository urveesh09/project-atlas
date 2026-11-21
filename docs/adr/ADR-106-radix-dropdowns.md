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
