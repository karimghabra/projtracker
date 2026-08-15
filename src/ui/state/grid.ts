/**
 * Where the cards go.
 *
 * A card says which column it starts in and how many columns it spans. Where it
 * lands vertically is not stored: it is worked out from the cards already
 * placed above it, so a short card leaves no hole underneath and no card has to
 * be given a height it does not have. Heights come from the browser, measured;
 * only a card the user has deliberately resized carries one.
 *
 * That is the whole reason this is not a plain CSS grid. A grid row is as tall
 * as its tallest cell, so a 500px Today beside a 140px note pad is 360px of
 * nothing — which is the complaint this is meant to answer, not restate.
 *
 * Pure and in one file so the packing can be tested without a browser: the
 * interesting cases (two cards competing for a column, a wide card spanning a
 * short one and a tall one) are arithmetic, not pixels.
 */

export interface Card {
  id: string;
  /** First column, 0-based. */
  x: number;
  /** How many columns it spans. */
  w: number;
  /** Height in pixels, as measured or as set. */
  h: number;
}

export interface Placed extends Card {
  /** Pixels from the top of the grid. */
  y: number;
}

export interface Point {
  /** Column under the pointer, as a fraction — 3.5 is halfway across column 3. */
  col: number;
  /** Pixels from the top of the grid. */
  y: number;
}

export const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/**
 * Drop every card as far up as it will go, into any hole it fits in.
 *
 * Cards are placed in order, each one rising to the highest position in its own
 * columns where nothing is already sitting. Not merely onto the bottom of those
 * columns: a short card beside a tall one leaves a hole under it, and the next
 * card that fits belongs in that hole rather than below everything.
 *
 * Without the backfill a board is mostly gaps as soon as two cards differ in
 * height, which is always. With it, the only empty space left is space nothing
 * could fill.
 *
 * The order still decides who gets first choice, and the column is still the
 * user's: a card rises, it never slides sideways. So dragging remains a thing
 * you can predict, which a fully automatic layout is not.
 */
export function place(cards: Card[], columns: number, gap: number): { placed: Placed[]; height: number } {
  const placed: Placed[] = [];

  for (const card of cards) {
    const w = clamp(Math.round(card.w), 1, columns);
    const x = clamp(Math.round(card.x), 0, columns - w);

    /*
      A card with nothing in it takes no room. Several panels draw nothing at
      all on a board that has no experiments or no notes yet, and reserving a
      gap for each of them is how a new user's dashboard ends up as a column of
      holes with three real cards in it.
    */
    if (card.h <= 0) {
      placed.push({ ...card, x, w, y: 0 });
      continue;
    }

    const beside = placed.filter((other) => other.h > 0 && other.x < x + w && x < other.x + other.w);
    // Every height something could rest on: the top, and the bottom of each
    // card it might sit under.
    const ledges = [0, ...beside.map((other) => other.y + other.h + gap)].sort((a, b) => a - b);
    const clashes = (y: number) =>
      beside.some((other) => y < other.y + other.h + gap && other.y < y + card.h + gap);

    const y = ledges.find((ledge) => !clashes(ledge)) ?? 0;
    placed.push({ ...card, x, w, y });
  }

  const height = Math.max(0, ...placed.filter((c) => c.h > 0).map((c) => c.y + c.h));
  return { placed, height };
}

/**
 * Where a dragged card would go if it were dropped here.
 *
 * The answer is an index in the order, not a coordinate: vertical position is
 * always derived, so "before that card" is the only thing a drop can mean. A
 * card counts as behind the pointer once the pointer is past its middle —
 * vertically for cards above and below, horizontally for cards beside it, which
 * is what makes dropping into the right-hand half of a row work.
 */
export function insertionIndex(placed: Placed[], point: Point, dragging?: string): number {
  let index = 0;
  for (const card of placed) {
    if (card.id === dragging) continue;
    // A card with nothing in it is not on the screen, so the pointer cannot be
    // past it. They all sit at the top, and counting them put every drop five
    // places further down the order than the pointer said.
    if (card.h <= 0) continue;
    const middleY = card.y + card.h / 2;
    const middleX = card.x + card.w / 2;
    const beside = point.y >= card.y && point.y <= card.y + card.h;
    if (point.y > middleY || (beside && point.col > middleX)) index++;
  }
  return index;
}

/** The column a card should start in for its left edge to sit under the pointer. */
export function columnFor(left: number, columnWidth: number, gap: number, w: number, columns: number): number {
  const step = columnWidth + gap;
  return clamp(Math.round(left / step), 0, Math.max(0, columns - w));
}

/**
 * Move `id` so that it sits at `index` in the order.
 *
 * The index is read against the list with the card already taken out, which is
 * what `insertionIndex` counts, so dragging a card one place to the right moves
 * it one place rather than not at all.
 */
export function reorder<T extends { id: string }>(items: T[], id: string, index: number): T[] {
  const without = items.filter((item) => item.id !== id);
  const moving = items.find((item) => item.id === id);
  if (!moving) return items;
  const at = clamp(index, 0, without.length);
  return [...without.slice(0, at), moving, ...without.slice(at)];
}
