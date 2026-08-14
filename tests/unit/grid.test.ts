/**
 * Packing the dashboard, without a browser.
 *
 * Heights come from the DOM in the real thing, which is exactly why they are a
 * parameter here: the interesting cases — two cards competing for a column, a
 * wide card spanning a short one and a tall one, a card dropped between two
 * others — are arithmetic, and arithmetic can be checked.
 */

import { describe, expect, it } from 'vitest';
import { columnFor, insertionIndex, place, reorder, type Card } from '../../src/ui/state/grid.ts';

const card = (id: string, x: number, w: number, h: number): Card => ({ id, x, w, h });

describe('cards fall as far as they fit', () => {
  it('puts two cards side by side, both at the top', () => {
    const { placed, height } = place([card('a', 0, 7, 400), card('b', 7, 5, 250)], 12, 16);
    expect(placed.map((c) => [c.id, c.x, c.y])).toEqual([
      ['a', 0, 0],
      ['b', 7, 0],
    ]);
    // The grid is as tall as its tallest column, without a trailing gap.
    expect(height).toBe(400);
  });

  it('stacks a card under the one it shares a column with', () => {
    const { placed } = place([card('a', 0, 7, 400), card('b', 0, 7, 100)], 12, 16);
    expect(placed[1]!.y).toBe(416);
  });

  it('lets a short column fill while a tall one is still occupied', () => {
    // The point of packing: 'c' does not wait for the 500px card beside it.
    const { placed } = place(
      [card('tall', 0, 6, 500), card('short', 6, 6, 100), card('c', 6, 6, 100)],
      12,
      16,
    );
    expect(placed[2]!.y).toBe(116);
  });

  it('makes a card that spans both clear the taller of them', () => {
    const { placed } = place(
      [card('a', 0, 6, 300), card('b', 6, 6, 120), card('wide', 0, 12, 80)],
      12,
      16,
    );
    expect(placed[2]!.y).toBe(316);
  });

  it('pulls a card back inside the grid rather than off the edge', () => {
    const { placed } = place([card('a', 9, 7, 100)], 12, 16);
    expect([placed[0]!.x, placed[0]!.w]).toEqual([5, 7]);
  });

  it('collapses to a single column without losing anybody', () => {
    const { placed } = place([card('a', 0, 7, 100), card('b', 7, 5, 100)], 1, 16);
    expect(placed.map((c) => [c.x, c.w, c.y])).toEqual([
      [0, 1, 0],
      [0, 1, 116],
    ]);
  });

  it('is empty for an empty grid, rather than a negative height', () => {
    expect(place([], 12, 16)).toEqual({ placed: [], height: 0 });
  });

  it('gives no room at all to a card with nothing in it', () => {
    // Half the panels draw nothing on a board with no experiments and no
    // notes; a gap reserved for each is how a new dashboard becomes holes.
    const { placed, height } = place(
      [card('nothing', 0, 6, 0), card('a', 0, 6, 100), card('b', 0, 6, 100)],
      12,
      16,
    );
    expect(placed.map((c) => c.y)).toEqual([0, 0, 116]);
    expect(height).toBe(216);
  });
});

describe('where a dragged card would land', () => {
  const placed = place(
    [card('a', 0, 6, 200), card('b', 6, 6, 200), card('c', 0, 12, 200)],
    12,
    16,
  ).placed;

  it('drops before everything when the pointer is above them all', () => {
    expect(insertionIndex(placed, { col: 1, y: 10 }, 'c')).toBe(0);
  });

  it('drops between two cards in a row when the pointer is in the second half', () => {
    // Past the middle of 'a', still level with it: after 'a', before 'b'.
    expect(insertionIndex(placed, { col: 4, y: 100 }, 'c')).toBe(1);
  });

  it('drops after a row once the pointer is below its middle', () => {
    expect(insertionIndex(placed, { col: 1, y: 190 }, 'c')).toBe(2);
  });

  it('does not count the card being dragged', () => {
    // Everything below 'a' — but 'a' itself is in the air, so it is not there.
    expect(insertionIndex(placed, { col: 11, y: 500 }, 'a')).toBe(2);
    expect(insertionIndex(placed, { col: 11, y: 500 })).toBe(3);
  });
});

describe('the column a card is dropped into', () => {
  it('snaps to the nearest column', () => {
    // 100px columns, 16px gaps: a left edge of 240 is nearest column 2.
    expect(columnFor(240, 100, 16, 5, 12)).toBe(2);
    expect(columnFor(0, 100, 16, 5, 12)).toBe(0);
  });

  it('will not leave part of the card off the right-hand edge', () => {
    expect(columnFor(5000, 100, 16, 5, 12)).toBe(7);
  });

  it('will not go left of the first column', () => {
    expect(columnFor(-400, 100, 16, 5, 12)).toBe(0);
  });
});

describe('moving a card in the order', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('moves one place right, which means past exactly one card', () => {
    expect(reorder(items, 'a', 1).map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves to the end, and to the start', () => {
    expect(reorder(items, 'a', 2).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(items, 'c', 0).map((i) => i.id)).toEqual(['c', 'a', 'b']);
  });

  it('clamps rather than dropping the card off the list', () => {
    expect(reorder(items, 'a', 99).map((i) => i.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(items, 'a', -5).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('leaves a list it does not recognise alone', () => {
    expect(reorder(items, 'nope', 1)).toBe(items);
  });
});
