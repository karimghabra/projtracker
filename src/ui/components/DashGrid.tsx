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
import { IconDrag } from './icons.tsx';
import { columnFor, insertionIndex, place, type Card, type Placed } from '../state/grid.ts';
import {
  COLUMNS,
  MIN_HEIGHT,
  MIN_SPAN,
  ROW_STEP,
  growsPast,
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

interface Sizing {
  id: PanelId;
  /** How many columns wide it would be if the pointer were released now. */
  w: number;
  /** A deliberate height, or null for as tall as its contents. */
  h: number | null;
}

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
  const [sizing, setSizing] = useState<Sizing | null>(null);

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

  /*
    The gesture in progress is kept in a ref as well as in state, and every
    handler reads the ref.

    React flushes a pointerdown synchronously but batches the moves that follow,
    so a handler can be one render behind the gesture it is handling. The state
    is for drawing; the ref is what the gesture actually is. Without this, a
    drag whose moves all arrive before a re-paint commits nothing at all — which
    is exactly what it looked like: an intermittently dead resize handle.
  */
  const live = useRef<{
    drag: (Drag & { fromLeft: number; fromTop: number }) | null;
    sizing: (Sizing & { fromLeft: number; fromTop: number; x: number }) | null;
    preview: { x: number; index: number } | null;
  }>({ drag: null, sizing: null, preview: null });

  // --------------------------------------------------------------- placing

  /*
    What the layout would be if the pointer were released now. The preview is
    the real thing — the same call that lays out the settled grid — so what you
    see while dragging is what you get when you let go.
  */
  let working = layout;
  if (sizing) working = moveCard(layout, sizing.id, { w: sizing.w });

  /**
   * How tall a card is: what it was given, or what it measured.
   *
   * A panel that grows is always what it measured — the day's list has to show
   * all of it, and a height given to it would keep it at that size after
   * something was ticked off or deleted.
   */
  const heightOfCard = (id: PanelId, given: number | null | undefined): number => {
    const measured = heights[id] ?? 0;
    if (growsPast(id) || given === null || given === undefined) return measured;
    return given;
  };

  const toCards = (from: Layout): Card[] =>
    panelOrder(from).map((panel) => {
      const spot = placeOf(from, panel.id);
      const set = heightOf(from, panel.id);
      const given = sizing?.id === panel.id ? sizing.h : set;
      const h = heightOfCard(panel.id, given);
      return columns === 1
        ? { id: panel.id, x: 0, w: 1, h }
        : { id: panel.id, x: spot.x, w: spot.w, h };
    });

  if (drag?.moved && live.current.preview) {
    working = moveCard(working, drag.id, live.current.preview);
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
    const started = {
      id,
      grabX: event.clientX - box.left - left(card),
      grabY: event.clientY - box.top - card.y,
      atX: event.clientX - box.left,
      atY: event.clientY - box.top,
      moved: false,
      fromLeft: left(card),
      fromTop: card.y,
    };
    live.current = { drag: started, sizing: null, preview: null };
    setDrag(started);
  };

  const onDragMove = (event: React.PointerEvent) => {
    const held = live.current.drag;
    const box = surface.current?.getBoundingClientRect();
    if (!held || !box) return;
    const atX = event.clientX - box.left;
    const atY = event.clientY - box.top;
    const next = {
      ...held,
      atX,
      atY,
      // Three pixels of slop, so a press on the grip is still a press.
      moved:
        held.moved ||
        Math.abs(atX - held.grabX - held.fromLeft) > 3 ||
        Math.abs(atY - held.grabY - held.fromTop) > 3,
    };
    live.current.drag = next;
    if (next.moved && columnWidth > 0) {
      const settled = place(toCards(layout), columns, GAP).placed;
      live.current.preview = {
        x: columnFor(atX - next.grabX, columnWidth, GAP, spanOf(layout, held.id, columns), columns),
        index: insertionIndex(settled, { col: atX / (columnWidth + GAP), y: atY }, held.id),
      };
    }
    setDrag(next);
  };

  const endDrag = () => {
    const held = live.current.drag;
    const where = live.current.preview;
    if (held?.moved && where) onLayout(moveCard(layout, held.id, where));
    live.current = { drag: null, sizing: null, preview: null };
    setDrag(null);
  };

  // -------------------------------------------------------------- resizing

  const startResize = (id: PanelId) => (event: React.PointerEvent) => {
    if (event.button !== 0 || columns === 1) return;
    const card = at.get(id);
    if (!card) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    const started = {
      id,
      w: card.w,
      h: heightOf(layout, id) ?? null,
      // Where the card is now: resizing moves its right and bottom edges, never
      // its top-left, so these hold for the whole gesture.
      fromLeft: left(card),
      fromTop: card.y,
      x: card.x,
    };
    live.current = { drag: null, sizing: started, preview: null };
    setSizing({ id, w: started.w, h: started.h });
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const held = live.current.sizing;
    const box = surface.current?.getBoundingClientRect();
    if (!held || !box) return;
    const right = event.clientX - box.left;
    const bottom = event.clientY - box.top;
    const w = Math.max(
      MIN_SPAN,
      Math.min(COLUMNS - held.x, Math.round((right - held.fromLeft + GAP) / (columnWidth + GAP))),
    );
    /*
      Height is in steps so two cards can be made to match by eye. Going back to
      "as tall as its contents" is a double-click on the same handle rather than
      a magic zone near the natural height — a card you shortened once should
      not silently grow again because the list inside it did.
    */
    const asked = growsPast(held.id)
      ? null
      : Math.max(MIN_HEIGHT, Math.round((bottom - held.fromTop) / ROW_STEP) * ROW_STEP);
    live.current.sizing = { ...held, w, h: asked };
    setSizing({ id: held.id, w, h: asked });
  };

  const endResize = () => {
    const held = live.current.sizing;
    if (held) {
      onLayout(setHeight(moveCard(layout, held.id, { w: held.w }), held.id, held.h));
    }
    live.current = { drag: null, sizing: null, preview: null };
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
          const given = sizing?.id === panel.id ? sizing.h : set;
          // A growing card is never given a fixed height, so it cannot clip.
          const fixed = growsPast(panel.id) ? undefined : given;
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
                    <IconDrag size={13} />
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
