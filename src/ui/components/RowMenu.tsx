/**
 * The rest of a row's verbs, behind one button.
 *
 * A task on the day's list can be started, put off, run as a protocol, taken
 * off today, sent back to the pool or deleted — eight buttons in a row, which
 * on a card a third of the screen wide left about a hundred pixels for the
 * name of the task. The three or four you reach for every day stay on the row;
 * the rest live here.
 *
 * Fixed rather than absolute, positioned from the button's own rectangle: a
 * panel clips its overflow, so a menu drawn inside the row would be cut off by
 * the bottom of the card it is in.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { IconMore } from './icons.tsx';

export interface RowAction {
  label: string;
  onSelect: () => void;
  /**
   * The accessible name, when the visible text is too short to stand alone.
   * "Delete" in a menu is only clear because of the row it came from, and a
   * screen reader does not have the row.
   */
  name?: string;
  icon?: ReactNode;
  testId?: string;
  /** Drawn apart, at the bottom: the ones you cannot take back by shrugging. */
  danger?: boolean;
}

export function RowMenu({
  label,
  actions,
  testId,
}: {
  /** What the row is, for the button's name: "More for Image samples". */
  label: string;
  actions: RowAction[];
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const box = button.current.getBoundingClientRect();
    // Roughly how tall it will be, so a menu near the bottom of the window
    // opens upwards instead of off the end of it.
    const tall = actions.length * 30 + 12;
    const below = box.bottom + 4;
    setAt({
      top: below + tall > window.innerHeight ? Math.max(8, box.top - tall - 4) : below,
      right: Math.max(8, window.innerWidth - box.right),
    });
  }, [open, actions.length]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) {
        setOpen(false);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        button.current?.focus();
      }
    };
    // Capture, so a click landing on a card behind the menu closes it first.
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);

  /** Up and down through the items, because a menu that needs a mouse is a menu. */
  const walk = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = [...(menu.current?.querySelectorAll('button') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
    items[(next + items.length) % items.length]?.focus();
  };

  return (
    <>
      <button
        ref={button}
        className="btn ghost icon sm"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`More for ${label}`}
        title="More"
        data-testid={testId}
        onClick={() => setOpen(!open)}
      >
        <IconMore size={13} />
      </button>
      {open && at && (
        <div
          ref={menu}
          className="row-menu"
          /*
            A group of buttons rather than role="menu": the ARIA menu pattern
            promises roving tabindex and typeahead, and a half-kept promise
            reads worse to a screen reader than a plain list of buttons does.
          */
          role="group"
          aria-label={`More for ${label}`}
          style={{ top: at.top, right: at.right }}
          onKeyDown={walk}
        >
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.danger ? 'row-menu-item danger' : 'row-menu-item'}
              aria-label={action.name}
              data-testid={action.testId}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
