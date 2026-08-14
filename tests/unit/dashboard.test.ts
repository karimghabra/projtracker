/**
 * The dashboard's layout rules, without a browser.
 *
 * These are preferences rather than facts about the work, but they still have
 * rules worth holding: a cap folds rather than truncates, Today cannot be
 * hidden, a card cannot be dragged off the edge of the grid, and a stored
 * layout from another build cannot break the screen that reads it.
 */

import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  DEFAULT_LAYOUT,
  LAYOUT_KEY,
  LEGACY_READY_KEY,
  MIN_HEIGHT,
  MIN_SPAN,
  PANELS,
  ROW_STEP,
  capOf,
  heightOf,
  isCollapsed,
  isHidden,
  migrateLegacy,
  moveCard,
  panelOrder,
  panelOrderIds,
  parseLayout,
  placeOf,
  readLayout,
  setHeight,
  toggleCollapsed,
  toggleExpanded,
  toggleHidden,
  writeLayout,
} from '../../src/ui/state/dashboard.ts';

/** A Storage that lives in a variable, so persistence can be driven directly. */
function fakeStore(initial?: string) {
  const box: Record<string, string> = initial ? { [LAYOUT_KEY]: initial } : {};
  return {
    getItem: (key: string) => box[key] ?? null,
    setItem: (key: string, value: string) => {
      box[key] = value;
    },
    removeItem: (key: string) => {
      delete box[key];
    },
    box,
  };
}

describe('what is on the dashboard', () => {
  it('starts with every panel on the grid, in its declared place', () => {
    const ids = panelOrder(DEFAULT_LAYOUT).map((p) => p.id);
    expect(ids).toEqual(PANELS.map((p) => p.id));
    expect(ids[0]).toBe('today');
    // Nothing overlaps to begin with: the defaults are two tidy columns.
    for (const panel of PANELS) {
      const { x, w } = placeOf(DEFAULT_LAYOUT, panel.id);
      expect(x + w).toBeLessThanOrEqual(COLUMNS);
    }
  });

  it('hides a panel, and stops drawing it', () => {
    const layout = toggleHidden(DEFAULT_LAYOUT, 'scaffolds');
    expect(isHidden(layout, 'scaffolds')).toBe(true);
    expect(panelOrder(layout).map((p) => p.id)).not.toContain('scaffolds');
    // ...but it keeps its place in the order, so unhiding puts it back where
    // it was rather than at the end.
    expect(panelOrderIds(layout)).toContain('scaffolds');
  });

  it('refuses to hide the day, which is the screen itself', () => {
    // Opening on nothing is not a layout anybody chose.
    const layout = toggleHidden(DEFAULT_LAYOUT, 'today');
    expect(layout).toBe(DEFAULT_LAYOUT);
    expect(panelOrder(layout).map((p) => p.id)).toContain('today');
  });

  it('collapses and uncollapses', () => {
    const shut = toggleCollapsed(DEFAULT_LAYOUT, 'calendar');
    expect(isCollapsed(shut, 'calendar')).toBe(true);
    expect(isCollapsed(toggleCollapsed(shut, 'calendar'), 'calendar')).toBe(false);
    // A collapsed panel is still on the screen; it is shut, not gone.
    expect(panelOrder(shut).map((p) => p.id)).toContain('calendar');
  });
});

describe('moving and sizing a card', () => {
  it('puts a card where it was dropped', () => {
    const layout = moveCard(DEFAULT_LAYOUT, 'notes', { x: 0, w: 6, index: 0 });
    expect(placeOf(layout, 'notes')).toEqual({ x: 0, w: 6 });
    expect(panelOrder(layout)[0]!.id).toBe('notes');
  });

  it('keeps every card on the grid', () => {
    // Dropped off the right-hand edge, or narrower than a column of words.
    expect(placeOf(moveCard(DEFAULT_LAYOUT, 'notes', { x: 11, w: 5 }), 'notes')).toEqual({
      x: 7,
      w: 5,
    });
    expect(placeOf(moveCard(DEFAULT_LAYOUT, 'notes', { w: 1 }), 'notes').w).toBe(MIN_SPAN);
    expect(placeOf(moveCard(DEFAULT_LAYOUT, 'notes', { w: 99 }), 'notes').w).toBe(COLUMNS);
  });

  it('stores nothing for a card put back where it started', () => {
    const spec = PANELS.find((p) => p.id === 'notes')!;
    const moved = moveCard(DEFAULT_LAYOUT, 'notes', { x: 0, w: 6 });
    expect(moved.at.notes).toBeDefined();
    const home = moveCard(moved, 'notes', { x: spec.x, w: spec.w });
    expect(home.at.notes).toBeUndefined();
  });

  it('reorders without losing or duplicating a card', () => {
    const layout = moveCard(DEFAULT_LAYOUT, 'progress', { index: 1 });
    const ids = panelOrderIds(layout);
    expect(ids).toHaveLength(PANELS.length);
    expect(new Set(ids).size).toBe(PANELS.length);
    expect(ids[1]).toBe('progress');
  });

  it('sets a height in steps, with a floor, and clears it again', () => {
    const layout = setHeight(DEFAULT_LAYOUT, 'calendar', 301);
    expect(heightOf(layout, 'calendar')! % ROW_STEP).toBe(0);
    expect(heightOf(setHeight(DEFAULT_LAYOUT, 'calendar', 4), 'calendar')).toBe(MIN_HEIGHT);
    expect(heightOf(setHeight(layout, 'calendar', null), 'calendar')).toBeUndefined();
  });
});

describe('a cap folds, and says how much it folded', () => {
  const rows = Array.from({ length: 12 }, (_, i) => i);

  it('shows the first few and counts the rest', () => {
    const { shown, more } = capOf(DEFAULT_LAYOUT, 'experiments', rows);
    expect(shown).toHaveLength(5);
    expect(more).toBe(7);
  });

  it('says nothing when there is nothing to fold', () => {
    const { shown, more } = capOf(DEFAULT_LAYOUT, 'experiments', [1, 2]);
    expect(shown).toEqual([1, 2]);
    expect(more).toBe(0);
  });

  it('shows everything once expanded', () => {
    const layout = toggleExpanded(DEFAULT_LAYOUT, 'experiments');
    const { shown, more } = capOf(layout, 'experiments', rows);
    expect(shown).toHaveLength(12);
    expect(more).toBe(0);
  });

  it('never caps the day, because nothing dated may disappear', () => {
    // §5. A hundred-item day lists a hundred items; the card scrolls.
    const hundred = Array.from({ length: 100 }, (_, i) => i);
    const { shown, more } = capOf(DEFAULT_LAYOUT, 'today', hundred);
    expect(shown).toHaveLength(100);
    expect(more).toBe(0);
  });

  it('knows the difference between expanded and nothing to expand', () => {
    // Both report more: 0. Only one of them should offer to show fewer.
    const expandedLayout = toggleExpanded(DEFAULT_LAYOUT, 'experiments');
    expect(capOf(expandedLayout, 'experiments', rows).foldable).toBe(true);
    expect(capOf(expandedLayout, 'experiments', [1, 2]).foldable).toBe(false);
    expect(capOf(DEFAULT_LAYOUT, 'today', rows).foldable).toBe(false);
  });
});

describe('the ready pool keeps the collapse it already had', () => {
  it('carries the old key over, once', () => {
    const store = fakeStore();
    store.setItem(LEGACY_READY_KEY, 'closed');
    const layout = migrateLegacy(store, DEFAULT_LAYOUT);
    expect(isCollapsed(layout, 'ready')).toBe(true);
    // ...and then forgets it, so a later collapse from the chooser wins.
    expect(store.getItem(LEGACY_READY_KEY)).toBeNull();
    expect(isCollapsed(migrateLegacy(store, DEFAULT_LAYOUT), 'ready')).toBe(false);
  });

  it('leaves an open pool open', () => {
    const store = fakeStore();
    store.setItem(LEGACY_READY_KEY, 'open');
    expect(migrateLegacy(store, DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });

  it('does nothing for somebody who never had the old key', () => {
    expect(migrateLegacy(fakeStore(), DEFAULT_LAYOUT)).toEqual(DEFAULT_LAYOUT);
  });
});

describe('a layout survives being stored, and being wrong', () => {
  it('round-trips', () => {
    const store = fakeStore();
    const layout = setHeight(
      moveCard(toggleCollapsed(toggleHidden(DEFAULT_LAYOUT, 'notes'), 'calendar'), 'progress', {
        x: 0,
        w: 12,
        index: 1,
      }),
      'calendar',
      312,
    );
    writeLayout(store, layout);
    expect(readLayout(store)).toEqual(layout);
  });

  it('an empty store is the default', () => {
    expect(readLayout(fakeStore())).toEqual(DEFAULT_LAYOUT);
  });

  it('drops panel names it does not know', () => {
    // A layout written by a newer build, or edited by hand.
    const layout = parseLayout('{"hidden":["nope","notes"],"order":["nope","notes"],"at":{"nope":{"x":0,"w":4}}}');
    expect(layout.hidden).toEqual(['notes']);
    expect(layout.order).toEqual(['notes']);
    expect(layout.at).toEqual({});
  });

  it('drops a stored attempt to hide the day', () => {
    expect(parseLayout('{"hidden":["today"]}').hidden).toEqual([]);
  });

  it('pulls a stored card back onto the grid', () => {
    const layout = parseLayout('{"at":{"notes":{"x":40,"w":900}}}');
    expect(layout.at.notes).toEqual({ x: 0, w: COLUMNS });
  });

  it('refuses a card of no height at all', () => {
    expect(parseLayout('{"height":{"notes":2}}').height.notes).toBe(MIN_HEIGHT);
    expect(parseLayout('{"height":{"notes":"tall"}}').height).toEqual({});
  });

  it('draws a repeated panel once', () => {
    // Twice in the order would be drawn twice and dragged once.
    expect(parseLayout('{"order":["notes","notes","today"]}').order).toEqual(['notes', 'today']);
  });

  it('survives nonsense rather than taking the screen down with it', () => {
    expect(parseLayout('not json at all')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('null')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('[]')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"hidden":"notes"}')).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout('{"at":{"notes":7}}')).toEqual(DEFAULT_LAYOUT);
  });
});
