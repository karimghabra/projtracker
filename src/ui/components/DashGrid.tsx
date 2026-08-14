/**
 * The dashboard's surface: cards you can move and resize.
 *
 * Cards are positioned absolutely from measured heights rather than laid out by
 * CSS, because a CSS grid row is as tall as its tallest cell — a 500px Today
 * beside a 140px note pad would be 360px of nothing, which is the complaint
 * this is answering. `grid.ts` does the packing; this file measures, listens to
 * a pointer, and draws.
 *
 * Everything here is a preference, so nothing here touches the vault.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { columnFor, insertionIndex, place, type Card, type Placed } from '../state/grid.ts';
import {
  COLUMNS,
  MIN_HEIGHT,
  MIN_SPAN,
  ROW_STEP,
  heightOf,
  moveCard,
  panelOrder,
  placeOf,
  setHeight,
  type Layout,
  type PanelId,
} from '../state/dashboard.ts';

/** Matches `--space-4`, the gap the two columns used to have between them. */
const GAP = 16;

/**
 * Below this the grid is one card wide. Twelve columns of 60px is not a layout
 * anybody chose; it is a layout that happens to somebody on a laptop.
 */
const NARROW = 900;

export interface Drag {
  id: PanelId;
  /** Where in the card the pointer took hold, in pixels. */
  grabX: number;
  grabY: number;
  /** Where the pointer is now, relative to the grid. */
  atX: number;
  atY: number;
  /** Set once the pointer has actually travelled, so a click is not a drag. */
  moved: boolean;
}

export function DashGrid({
  layout,
  onLayout,
  render,
  footer,
}: {
  layout: Layout;
  onLayout: (next: Layout) => void;
  /** What to draw inside each card. */
  render: (id: PanelId) => ReactNode;
  /** Drawn under the grid, inside the same scroller — the capture box. */
  footer?: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<PanelId, HTMLElement>());
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [sizing, setSizing] = useState<{ id: PanelId; w: number; h: number | null } | null>(null);

  const columns = width > 0 && width < NARROW ? 1 : COLUMNS;
  const columnWidth = width > 0 ? (width - GAP * (columns - 1)) / columns : 0;
  const order = panelOrder(layout);

  // -------------------------------------------------------------- measuring

  const measure = useCallback(() => {
    if (surface.current) setWidth(surface.current.clientWidth);
    setHeights((old) => {
      let changed = false;
      const next = { ...old };
      for (const [id, element] of cards.current) {
        // What the card would like to be, which is not what it is: a card given
        // a height scrolls inside, so this is the content's height either way.
        const h = Math.round(element.scrollHeight);
        if (h > 0 && next[id] !== h) {
          next[id] = h;
          changed = true;
        }
      }
      return changed ? next : old;
    });
  }, []);

  useLayoutEffect(measure);

  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => measure());
    if (surface.current) observer.observe(surface.current);
    for (const element of cards.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [measure, order.length]);

  const hold = useCallback((id: PanelId, element: HTMLElement | null) => {
    if (element) cards.current.set(id, element);
    else cards.current.delete(id);
  }, []);

  // --------------------------------------------------------------- placing

  /*
    What the layout would be if the pointer were released now. The preview is
    the real thing — the same call that lays out the settled grid — so what you
    see while dragging is what you get when you let go.
  */
  let working = layout;
  if (sizing) working = moveCard(layout, sizing.id, { w: sizing.w });

  const toCards = (from: Layout): Card[] =>
    panelOrder(from).map((panel) => {
      const spot = placeOf(from, panel.id);
      const set = heightOf(from, panel.id);
      const measured = heights[panel.id] ?? 0;
      const h = sizing?.id === panel.id && sizing.h !== null ? sizing.h : (set ?? measured);
      return columns === 1
        ? { id: panel.id, x: 0, w: 1, h }
        : { id: panel.id, x: spot.x, w: spot.w, h };
    });

  let preview: { x: number; index: number } | null = null;
  if (drag && drag.moved && columnWidth > 0) {
    const settled = place(toCards(working), columns, GAP).placed;
    const x = columnFor(drag.atX - drag.grabX, columnWidth, GAP, spanOf(working, drag.id, columns), columns);
    const index = insertionIndex(settled, { col: drag.atX / (columnWidth + GAP), y: drag.atY }, drag.id);
    preview = { x, index };
    working = moveCard(working, drag.id, { x, index });
  }

  const { placed, height } = place(toCards(working), columns, GAP);
  const at = new Map(placed.map((card) => [card.id, card]));

  const left = (card: Placed) => card.x * (columnWidth + GAP);
  const wide = (card: Placed) => card.w * columnWidth + (card.w - 1) * GAP;

  // -------------------------------------------------------------- dragging

  const startDrag = (id: PanelId) => (event: React.PointerEvent) => {
    if (event.button !== 0 || columns === 1) return;
    const card = at.get(id);
    const box = surface.current?.getBoundingClientRect();
    if (!card || !box) return;
    event.preventDefault();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({
      id,
      grabX: event.clientX - box.left - left(card),
      grabY: event.clientY - box.top - card.y,
      atX: event.clientX - box.left,
      atY: event.clientY - box.top,
      moved: false,
    });
  };

  const onDragMove = (event: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect();
    if (!drag || !box) return;
    const atX = event.clientX - box.left;
    const atY = event.clientY - box.top;
    setDrag({
      ...drag,
      atX,
      atY,
      // Three pixels of slop, so a click on the grip is still a click.
      moved: drag.moved || Math.abs(atX - drag.grabX - left(at.get(drag.id)!)) > 3 || Math.abs(atY - drag.grabY - at.get(drag.id)!.y) > 3,
    });
  };

  const endDrag = () => {
    if (drag?.moved && preview) onLayout(moveCard(layout, drag.id, preview));
    setDrag(null);
  };

  // -------------------------------------------------------------- resizing

  const startResize = (id: PanelId) => (event: React.PointerEvent) => {
    if (event.button !== 0 || columns === 1) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const spot = placeOf(layout, id);
    setSizing({ id, w: spot.w, h: heightOf(layout, id) ?? null });
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const card = sizing && at.get(sizing.id);
    const box = surface.current?.getBoundingClientRect();
    if (!sizing || !card || !box) return;
    const right = event.clientX - box.left;
    const bottom = event.clientY - box.top;
    const w = Math.max(
      MIN_SPAN,
      Math.min(COLUMNS - card.x, Math.round((right - left(card) + GAP) / (columnWidth + GAP))),
    );
    /*
      Height is in steps so two cards can be made to match by eye. Going back to
      "as tall as its contents" is a double-click on the same handle rather than
      a magic zone near the natural height — a card you shortened once should
      not silently grow again because the list inside it did.
    */
    const asked = Math.max(MIN_HEIGHT, Math.round((bottom - card.y) / ROW_STEP) * ROW_STEP);
    setSizing({ ...sizing, w, h: asked });
  };

  const endResize = () => {
    if (sizing) {
      let next = moveCard(layout, sizing.id, { w: sizing.w });
      next = setHeight(next, sizing.id, sizing.h);
      onLayout(next);
    }
    setSizing(null);
  };

  // ---------------------------------------------------------------- drawing

  return (
    <div className="dash" data-testid="dash">
      <div
        className={drag?.moved ? 'dash-grid dragging' : 'dash-grid'}
        data-testid="dash-grid"
        data-columns={columns}
        ref={surface}
        style={{ height: height || undefined }}
        onPointerMove={(event) => {
          if (drag) onDragMove(event);
          if (sizing) onResizeMove(event);
        }}
        onPointerUp={() => {
          if (drag) endDrag();
          if (sizing) endResize();
        }}
        onPointerCancel={() => {
          setDrag(null);
          setSizing(null);
        }}
      >
        {order.map((panel) => {
          const card = at.get(panel.id)!;
          const held = drag?.id === panel.id && drag.moved;
          const set = heightOf(working, panel.id);
          const fixed = sizing?.id === panel.id ? sizing.h : set;
          /*
            Several panels draw nothing until there is something to draw — no
            experiments, no notes yet. Measured at nothing, they get no handles
            and no room, rather than a grip floating in the middle of a gap.
          */
          const empty = card.h === 0;
          return (
            <div
              key={panel.id}
              ref={(element) => hold(panel.id, element)}
              className={held ? 'dash-card held' : 'dash-card'}
              data-testid={`card-${panel.id}`}
              data-x={card.x}
              data-w={card.w}
              data-fixed={fixed ? 'true' : undefined}
              style={{
                width: columnWidth > 0 ? wide(card) : undefined,
                /*
                  `left`/`top` rather than a transform, which would look the
                  same and quietly break every dialog: a transformed element is
                  the containing block for anything `position: fixed` inside it,
                  and half these panels open a modal.
                */
                left: held ? drag.atX - drag.grabX : left(card),
                top: held ? drag.atY - drag.grabY : card.y,
                height: fixed ?? undefined,
              }}
            >
              <div className="dash-card-body">{render(panel.id)}</div>
              {columns > 1 && !empty && (
                <>
                  {/*
                    The grip is a separate target from the heading, which is the
                    collapse control: one gesture per thing, so neither has to
                    guess what a press meant.
                  */}
                  <button
                    className="card-grip"
                    data-testid={`grip-${panel.id}`}
                    aria-label={`Move ${panel.title}`}
                    onPointerDown={startDrag(panel.id)}
                  >
                    <Grip />
                  </button>
                  <button
                    className="card-resize"
                    data-testid={`resize-${panel.id}`}
                    aria-label={`Resize ${panel.title}`}
                    title="Drag to resize; double-click to fit the contents"
                    onPointerDown={startResize(panel.id)}
                    onDoubleClick={() => onLayout(setHeight(layout, panel.id, null))}
                  />
                </>
              )}
            </div>
          );
        })}
      </div>
      {footer}
    </div>
  );
}

const spanOf = (layout: Layout, id: PanelId, columns: number) =>
  columns === 1 ? 1 : placeOf(layout, id).w;

function Grip() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
      {[3, 7].map((x) =>
        [3, 7, 11].map((y) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" fill="currentColor" />),
      )}
    </svg>
  );
}
