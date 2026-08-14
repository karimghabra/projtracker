/**
 * Dragging a row up or down a list.
 *
 * The day's list used to carry two chevrons on every row, which were four of
 * the eight buttons that left a third-width card about a hundred pixels for the
 * name of the task. This replaces them. The keyboard path did not go with them:
 * Alt and an arrow does the same thing, through the same call.
 *
 * The rules that made the buttons the right answer once still apply, so:
 * nothing happens until the pointer has actually travelled, a press on a
 * checkbox or a button is never a drag, and the whole gesture is one call to
 * the command layer at the end — one undo step, not one per pixel.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface RowHandle {
  onGrab: (event: React.PointerEvent) => void;
  rowRef: (element: HTMLElement | null) => void;
  dragging: boolean;
  /** Where it would land: a line above this row, or below the last one. */
  dropBefore: boolean;
  dropAfter: boolean;
}

/** Far enough that it was meant, near enough that it feels immediate. */
const THRESHOLD = 4;

export function useRowDrag(commit: (key: string, index: number) => void) {
  const rows = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<{
    key: string;
    startY: number;
    over: number;
    moved: boolean;
  } | null>(null);

  /** The rows as they are on screen, top to bottom. */
  const inOrder = useCallback(
    () =>
      [...rows.current.entries()]
        .map(([key, element]) => ({ key, box: element.getBoundingClientRect() }))
        .sort((a, b) => a.box.top - b.box.top),
    [],
  );

  /** How many rows the pointer is past — which is where it would be dropped. */
  const indexAt = useCallback(
    (y: number) => inOrder().filter((row) => y > row.box.top + row.box.height / 2).length,
    [inOrder],
  );

  useEffect(() => {
    if (!drag) return;
    const move = (event: PointerEvent) => {
      const moved = drag.moved || Math.abs(event.clientY - drag.startY) > THRESHOLD;
      // A drag is not a selection. Chromium starts one on the way past.
      if (moved && !drag.moved) document.getSelection()?.removeAllRanges();
      setDrag({ ...drag, moved, over: indexAt(event.clientY) });
    };
    const up = () => {
      if (drag.moved) commit(drag.key, drag.over);
      setDrag(null);
    };
    const cancel = () => setDrag(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [drag, commit, indexAt]);

  const count = () => rows.current.size;

  return {
    /** True while a row is actually in the air, for the list's own styling. */
    active: Boolean(drag?.moved),
    row(key: string): RowHandle {
      const order = drag?.moved ? inOrder().map((row) => row.key) : [];
      const at = order.indexOf(key);
      return {
        rowRef: (element) => {
          if (element) rows.current.set(key, element);
          else rows.current.delete(key);
        },
        onGrab: (event) => {
          // A press on something that does something is that thing, not a drag.
          if (event.button !== 0) return;
          if ((event.target as HTMLElement).closest('button, input, a, textarea')) {
            return;
          }
          setDrag({ key, startY: event.clientY, over: indexAt(event.clientY), moved: false });
        },
        dragging: drag?.moved === true && drag.key === key,
        dropBefore: drag?.moved === true && drag.key !== key && drag.over === at,
        dropAfter:
          drag?.moved === true && drag.over >= count() && at === count() - 1 && drag.key !== key,
      };
    },
  };
}
