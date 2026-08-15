/**
 * What is on the dashboard, where, how wide, and how much of it.
 *
 * The screen grew one panel at a time into two fixed columns, and ended up two
 * and a half screens tall on a real board with the thing you look at least — a
 * grid of days — furthest from the top. Rather than pick an order that suits
 * one person, the order is theirs: every panel can be collapsed, hidden, moved
 * anywhere on a twelve-column grid, and made wider or shorter, and the choice
 * survives a reload.
 *
 * Kept as plain data with pure functions over it, so the rules are testable
 * without a browser; `grid.ts` does the packing. Persistence is a thin wrapper
 * at the bottom taking any `Storage`, which is what lets a test drive it with a
 * fake one.
 *
 * This is a preference about a screen, not a fact about the work, so it lives
 * in local storage rather than in the vault: two machines looking at the same
 * board are entitled to different dashboards, and a layout in the vault would
 * be a change to sync every time somebody collapsed something.
 */

import { clamp } from './grid.ts';

export type PanelId =
  | 'today'
  | 'in-progress'
  | 'ready'
  | 'projects'
  | 'calendar'
  | 'upcoming'
  | 'experiments'
  | 'scaffolds'
  | 'notes'
  | 'progress';

/** Twelve, so halves, thirds and quarters are all whole numbers of columns. */
export const COLUMNS = 12;
/** Narrower than this and a panel is a column of wrapped words. */
export const MIN_SPAN = 3;
/** A deliberate height is set in steps, so two cards can be made to match. */
export const ROW_STEP = 24;
export const MIN_HEIGHT = ROW_STEP * 5;

export interface PanelSpec {
  id: PanelId;
  title: string;
  /** Where it starts and how wide it is, before anybody moves anything. */
  x: number;
  w: number;
  /**
   * Panels that cannot be hidden. Today is the screen's reason to exist, and
   * hiding the day's list would leave an app that opens on nothing.
   */
  required?: boolean;
  /**
   * How many rows before the rest are folded behind a "more" row. Absent means
   * the panel is naturally bounded — a calendar is a month whatever happens.
   *
   * Today is deliberately absent: §5 says nothing dated disappears silently,
   * and a capped day list would be exactly that.
   */
  cap?: number;
  /**
   * A height set on this panel is a floor, not a ceiling: it grows past it to
   * keep everything on screen rather than scrolling inside itself.
   *
   * For the day's list, which must show all of it. Shortening the card is then
   * a way of saying "at least this tall", and a day with thirty things on it
   * says so by being thirty things tall.
   */
  grows?: boolean;
}

/**
 * The order here is the default order on the grid, and the x/w pairs reproduce
 * the two columns this screen had before it had a grid — seven columns of work
 * on the left, five of context on the right. It is a starting point rather than
 * a claim about what matters: everything below exists to let somebody disagree
 * with it.
 */
export const PANELS: readonly PanelSpec[] = [
  { id: 'today', title: 'Today', x: 0, w: 7, required: true, grows: true },
  { id: 'calendar', title: 'Calendar', x: 7, w: 5 },
  { id: 'in-progress', title: 'In progress', x: 0, w: 7, cap: 6 },
  { id: 'upcoming', title: 'Coming up', x: 7, w: 5, cap: 5 },
  { id: 'ready', title: 'Ready to work on', x: 0, w: 7, cap: 8 },
  { id: 'experiments', title: 'Experiments', x: 7, w: 5, cap: 5 },
  { id: 'projects', title: 'Projects', x: 0, w: 7 },
  { id: 'scaffolds', title: 'In the pipeline', x: 7, w: 5, cap: 4 },
  { id: 'progress', title: 'Recent progress', x: 0, w: 7, cap: 8 },
  { id: 'notes', title: 'Recent thoughts', x: 7, w: 5 },
];

export interface Layout {
  hidden: PanelId[];
  collapsed: PanelId[];
  expanded: PanelId[];
  /** The order cards are packed in. Anything missing follows, in default order. */
  order: PanelId[];
  /** Only where they differ from the panel's default place. */
  at: Partial<Record<PanelId, { x: number; w: number }>>;
  /** A height in pixels, for panels somebody has deliberately sized. */
  height: Partial<Record<PanelId, number>>;
}

export const DEFAULT_LAYOUT: Layout = {
  hidden: [],
  collapsed: [],
  expanded: [],
  order: [],
  at: {},
  height: {},
};

const KNOWN = new Set<string>(PANELS.map((p) => p.id));
const isPanelId = (value: unknown): value is PanelId =>
  typeof value === 'string' && KNOWN.has(value);
const specOf = (id: PanelId) => PANELS.find((p) => p.id === id)!;

/** Where a panel sits, taking any move or resize into account. */
export function placeOf(layout: Layout, id: PanelId): { x: number; w: number } {
  const spec = specOf(id);
  const moved = layout.at[id];
  const w = clamp(Math.round(moved?.w ?? spec.w), MIN_SPAN, COLUMNS);
  const x = clamp(Math.round(moved?.x ?? spec.x), 0, COLUMNS - w);
  return { x, w };
}

export const heightOf = (layout: Layout, id: PanelId): number | undefined => layout.height[id];

/** True when a set height is a floor rather than a fixed size. */
export const growsPast = (id: PanelId): boolean => specOf(id).grows === true;

/**
 * The panels to draw, in the order they pack.
 *
 * A stored order need not mention every panel — a layout saved by an older
 * build will not know about a newer one — so anything unnamed follows in its
 * declared position rather than disappearing.
 */
export function panelOrder(layout: Layout): PanelSpec[] {
  const named = layout.order.filter((id) => KNOWN.has(id)).map(specOf);
  const rest = PANELS.filter((p) => !layout.order.includes(p.id));
  return [...named, ...rest].filter((p) => !layout.hidden.includes(p.id));
}

export const isHidden = (layout: Layout, id: PanelId) => layout.hidden.includes(id);
export const isCollapsed = (layout: Layout, id: PanelId) => layout.collapsed.includes(id);
export const isExpanded = (layout: Layout, id: PanelId) => layout.expanded.includes(id);

const toggle = (list: PanelId[], id: PanelId): PanelId[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Hiding a required panel is refused rather than ignored silently. */
export function toggleHidden(layout: Layout, id: PanelId): Layout {
  const spec = PANELS.find((p) => p.id === id);
  if (!spec || (spec.required && !layout.hidden.includes(id))) return layout;
  return { ...layout, hidden: toggle(layout.hidden, id) };
}

export function toggleCollapsed(layout: Layout, id: PanelId): Layout {
  return { ...layout, collapsed: toggle(layout.collapsed, id) };
}

export function toggleExpanded(layout: Layout, id: PanelId): Layout {
  return { ...layout, expanded: toggle(layout.expanded, id) };
}

/**
 * Put a panel at a column, a width, and a position in the order.
 *
 * All three at once because a drag changes all three, and applying them one at
 * a time would write three layouts to storage for one gesture.
 */
export function moveCard(
  layout: Layout,
  id: PanelId,
  to: { x?: number; w?: number; index?: number },
): Layout {
  if (!KNOWN.has(id)) return layout;
  const current = placeOf(layout, id);
  const w = clamp(Math.round(to.w ?? current.w), MIN_SPAN, COLUMNS);
  const x = clamp(Math.round(to.x ?? current.x), 0, COLUMNS - w);

  const at = { ...layout.at };
  const spec = specOf(id);
  // Back where it started is stored as nothing, so a reset stays a reset.
  if (x === spec.x && w === spec.w) delete at[id];
  else at[id] = { x, w };

  let order = layout.order;
  if (to.index !== undefined) {
    const full = panelOrderIds(layout);
    const without = full.filter((other) => other !== id);
    const index = clamp(Math.round(to.index), 0, without.length);
    order = [...without.slice(0, index), id, ...without.slice(index)];
  }

  return { ...layout, at, order };
}

/** Every panel in packing order, hidden ones included, so order survives hiding. */
export function panelOrderIds(layout: Layout): PanelId[] {
  const named = layout.order.filter((id) => KNOWN.has(id));
  return [...named, ...PANELS.map((p) => p.id).filter((id) => !named.includes(id))];
}

/** A deliberate height, or `null` to go back to being as tall as its contents. */
export function setHeight(layout: Layout, id: PanelId, px: number | null): Layout {
  if (!KNOWN.has(id)) return layout;
  const height = { ...layout.height };
  if (px === null) delete height[id];
  else height[id] = Math.max(MIN_HEIGHT, Math.round(px / ROW_STEP) * ROW_STEP);
  return { ...layout, height };
}

/**
 * How many rows a panel shows, and how many are folded away.
 *
 * A cap is a fold, never a truncation: the count of what is not shown is
 * returned so the panel can say so, because a list that silently stops is a
 * list you cannot trust.
 *
 * `foldable` is whether there is a fold to speak of at all — an expanded panel
 * reports `more: 0` like any other, and without this the panel could not tell
 * "expanded, with eleven rows behind it" from "six rows, nothing to fold" and
 * would offer to show fewer of nothing.
 */
export function capOf<T>(
  layout: Layout,
  id: PanelId,
  rows: T[],
): { shown: T[]; more: number; foldable: boolean } {
  const spec = PANELS.find((p) => p.id === id);
  const foldable = spec?.cap !== undefined && rows.length > spec.cap;
  if (!foldable || isExpanded(layout, id)) return { shown: rows, more: 0, foldable };
  return { shown: rows.slice(0, spec!.cap), more: rows.length - spec!.cap!, foldable };
}

// ------------------------------------------------------------- persistence

export const LAYOUT_KEY = 'protracker:dashboard';

/**
 * Anything unrecognised is dropped rather than trusted: a panel id from a
 * newer build, a hand-edited value, or a card six thousand columns wide must
 * not be able to break the screen that reads it.
 */
export function parseLayout(raw: string | null): Layout {
  if (!raw) return DEFAULT_LAYOUT;
  try {
    const value = JSON.parse(raw) as Partial<Layout>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_LAYOUT;
    const ids = (list: unknown): PanelId[] => (Array.isArray(list) ? list.filter(isPanelId) : []);

    const at: Layout['at'] = {};
    for (const [id, spot] of Object.entries(value.at ?? {})) {
      if (!isPanelId(id) || !spot || typeof spot !== 'object') continue;
      const { x, w } = spot as { x: unknown; w: unknown };
      if (typeof x !== 'number' || typeof w !== 'number' || !isFinite(x) || !isFinite(w)) continue;
      const width = clamp(Math.round(w), MIN_SPAN, COLUMNS);
      at[id] = { x: clamp(Math.round(x), 0, COLUMNS - width), w: width };
    }

    const height: Layout['height'] = {};
    for (const [id, px] of Object.entries(value.height ?? {})) {
      if (!isPanelId(id) || typeof px !== 'number' || !isFinite(px)) continue;
      height[id] = Math.max(MIN_HEIGHT, Math.round(px));
    }

    // One appearance each: a repeated id would be drawn twice and dragged once.
    const order = [...new Set(ids(value.order))];

    return {
      hidden: ids(value.hidden).filter((id) => !specOf(id).required),
      collapsed: ids(value.collapsed),
      expanded: ids(value.expanded),
      order,
      at,
      height,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function readLayout(store: Pick<Storage, 'getItem'>): Layout {
  return parseLayout(store.getItem(LAYOUT_KEY));
}

export function writeLayout(store: Pick<Storage, 'setItem'>, layout: Layout): void {
  store.setItem(LAYOUT_KEY, JSON.stringify(layout));
}

/**
 * The ready pool was the one panel that could already be shut, under its own
 * key. Somebody who shut it should not find it open again because the feature
 * became general — so the old answer is carried over once, then forgotten.
 */
export const LEGACY_READY_KEY = 'protracker:ready';

export function migrateLegacy(
  store: Pick<Storage, 'getItem' | 'removeItem'>,
  layout: Layout,
): Layout {
  const old = store.getItem(LEGACY_READY_KEY);
  if (old === null) return layout;
  store.removeItem(LEGACY_READY_KEY);
  if (old !== 'closed' || layout.collapsed.includes('ready')) return layout;
  return { ...layout, collapsed: [...layout.collapsed, 'ready'] };
}
