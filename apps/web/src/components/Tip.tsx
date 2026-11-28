import * as Primitive from '@radix-ui/react-tooltip';
import { useRef, useState, type ReactElement, type ReactNode } from 'react';

/** One provider for the whole viewer, so moving between controls shows tips without delay. */
export function TipProvider({ children }: { children: ReactNode }) {
  return (
    <Primitive.Provider delayDuration={350} skipDelayDuration={250}>
      {children}
    </Primitive.Provider>
  );
}

/**
 * A styled tooltip for an icon control (ADR-107), in place of the browser's `title`: the
 * control's own accessible name stays on the control; the tip repeats it for sighted
 * pointer and keyboard users, with its shortcut as a key chip. With `onlyIfLabelHidden`
 * the tip appears only while the control's text label is visually hidden (a narrow layout
 * turns it into an icon); a visible label needs no tip.
 */
export function Tip({
  label,
  shortcut,
  side = 'bottom',
  onlyIfLabelHidden = false,
  children,
}: {
  label: ReactNode;
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  onlyIfLabelHidden?: boolean;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const labelHidden = () => {
    const text = trigger.current?.querySelector('.action-label, .menu-label');
    return !text || getComputedStyle(text).position === 'absolute';
  };
  return (
    <Primitive.Root open={open} onOpenChange={(next) => setOpen(next && (!onlyIfLabelHidden || labelHidden()))}>
      <Primitive.Trigger asChild ref={trigger}>
        {children}
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content className="tip" side={side} sideOffset={6} collisionPadding={8}>
          {label}
          {shortcut ? <kbd className="tip-key">{shortcut}</kbd> : null}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
