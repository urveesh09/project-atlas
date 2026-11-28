import * as Popover from '@radix-ui/react-popover';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';
import { Tip } from './Tip';

/**
 * The city's menus share one slot: opening one closes another, and every menu keeps inside
 * the city card, which clips its overflow (ADR-107).
 */
export const CityMenus = createContext<{ open: string | null; setOpen(name: string | null): void; card: HTMLElement | null } | null>(null);

/**
 * A city menu (Scope, Saved views, Notes, Bands, Share): Radix UI's popover with the
 * viewer's menu surface (ADR-107, replacing the `<details>` menus of ADR-053). The trigger
 * is a button that names the menu and its count; where the city column is narrow it goes
 * icon-only and a tip shows the name. The panel floats below the trigger, flips or slides
 * to stay inside the card, and grows no taller than the room it has, scrolling beyond that.
 * Like the menus it replaces, it stays open while you work elsewhere in the city; the
 * trigger or Escape closes it, and focus returns to the trigger.
 */
export function CityMenu({
  name,
  icon,
  label,
  badge,
  align = 'start',
  children,
}: {
  name: string;
  icon: IconName;
  label: string;
  badge?: string | null;
  /** Which edge of the trigger the panel lines up with; Share, at the row's end, uses `end`. */
  align?: 'start' | 'end';
  children: ReactNode;
}) {
  const group = useContext(CityMenus);
  const [alone, setAlone] = useState(false);
  const open = group ? group.open === name : alone;
  const setOpen = (next: boolean) => {
    if (!group) setAlone(next);
    else if (next) group.setOpen(name);
    else if (group.open === name) group.setOpen(null);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <div className={`city-views city-${name}`} data-state={open ? 'open' : 'closed'}>
        <Tip label={label} onlyIfLabelHidden>
          <Popover.Trigger className="city-menu-trigger">
            <Icon name={icon} />
            <span className="menu-label">{label}</span>
            {badge ? (
              <span className="menu-badge" aria-hidden="true">
                {badge}
              </span>
            ) : null}
          </Popover.Trigger>
        </Tip>
        <Popover.Content
          className="city-views-panel"
          aria-label={label}
          side="bottom"
          align={align}
          sideOffset={6}
          collisionPadding={8}
          {...(group?.card ? { collisionBoundary: group.card } : {})}
          // Keep the menu open while the city is used around it, as before.
          onInteractOutside={(event) => event.preventDefault()}
          // Closing hands focus back to the trigger a task later. When another menu opened in
          // its place (or anything else took focus), leave focus where it now is.
          onCloseAutoFocus={(event) => {
            const active = document.activeElement;
            if (active && active !== document.body) event.preventDefault();
          }}
        >
          {children}
        </Popover.Content>
      </div>
    </Popover.Root>
  );
}
