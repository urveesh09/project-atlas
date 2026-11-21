import * as Primitive from '@radix-ui/react-select';
import type { ReactNode, Ref } from 'react';
import { Icon } from './Icon';

/** One choice in a `Select`. Values are strings: callers convert numbers at the edge. */
export interface Choice {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

/** A titled run of choices, drawn under a small heading (like an `<optgroup>`). */
export interface ChoiceGroup {
  group: string;
  choices: readonly Choice[];
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  choices: readonly (Choice | ChoiceGroup)[];
  /** Accessible name when no `<label>` points at `id`. */
  'aria-label'?: string;
  id?: string;
  disabled?: boolean;
  title?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The viewer's dropdown (ADR-106): Radix UI's accessible select, drawn with the viewer's own
 * control tokens. The trigger is a `combobox` button that a `<label>` or `aria-label` names,
 * like the native select it replaces; the open list is a floating panel with keyboard
 * navigation, type-ahead, a check on the current choice and scroll arrows when it is long.
 * The trigger and every option carry `data-value`, so tests and audits read and pick
 * choices by value, as they did with `<select>`.
 */
export function Select({ value, onValueChange, choices, id, disabled, title, className, ref, ...rest }: SelectProps) {
  return (
    <Primitive.Root value={inner(value)} onValueChange={(next) => onValueChange(outer(next))} disabled={disabled}>
      <Primitive.Trigger
        ref={ref}
        id={id}
        title={title}
        aria-label={rest['aria-label']}
        className={className ? `select-trigger ${className}` : 'select-trigger'}
        data-value={value}
      >
        <span className="select-value">
          <Primitive.Value />
        </span>
        <Primitive.Icon className="select-chevron">
          <Icon name="chevronDown" size={14} />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          className="select-content"
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          // Closing hands focus back to the trigger, but Radix does it a task later. If
          // something else has taken focus by then (a choice that opened an editor, a fast
          // keyboard user), leave it there instead of pulling it back.
          onCloseAutoFocus={(event) => {
            const active = document.activeElement;
            if (active && active !== document.body && !active.closest('.select-content')) event.preventDefault();
          }}
        >
          <Primitive.ScrollUpButton className="select-scroll">
            <Icon name="chevronUp" size={14} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-viewport">
            {choices.map((entry) =>
              'group' in entry ? (
                entry.choices.length ? (
                  <Primitive.Group key={`group:${entry.group}`}>
                    <Primitive.Label className="select-group">{entry.group}</Primitive.Label>
                    {entry.choices.map(item)}
                  </Primitive.Group>
                ) : null
              ) : (
                item(entry)
              ),
            )}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll">
            <Icon name="chevronDown" size={14} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

// Radix reserves the empty string (it clears the selection), but some filters use '' for
// "all" because a real choice may be named "all". Map it to a value no choice can hold.
const EMPTY = '\u0000';
const inner = (value: string) => (value === '' ? EMPTY : value);
const outer = (value: string) => (value === EMPTY ? '' : value);

function item(choice: Choice) {
  return (
    <Primitive.Item key={inner(choice.value)} value={inner(choice.value)} disabled={choice.disabled} className="select-item" data-value={choice.value}>
      <Primitive.ItemText>{choice.label}</Primitive.ItemText>
      <Primitive.ItemIndicator className="select-check">
        <Icon name="check" size={14} />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}
