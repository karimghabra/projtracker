import { describe, expect, it } from 'vitest';
import { list, one, parseArgs } from '../../src/cli/args.ts';

describe('parseArgs', () => {
  it('keeps every value of a repeated flag, in the order given', () => {
    // The regression this guards: `protocol recipe` and `run --take` advertise
    // repetition, but the parser kept only the last value — a recipe typed with
    // two ingredients was recorded with one, and nothing said so.
    const { flags } = parseArgs(['protocol', 'recipe', 'p1', '--takes', 'a:1', '--takes', 'b:2', '--makes', 'c:3']);
    expect(list(flags['takes'])).toEqual(['a:1', 'b:2']);
    expect(list(flags['makes'])).toEqual(['c:3']);
  });

  it('accumulates past two', () => {
    const { flags } = parseArgs(['--take', 'a:1', '--take', 'b:2', '--take', 'c:3']);
    expect(list(flags['take'])).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('leaves a flag given once as a single value', () => {
    const { flags } = parseArgs(['wait', 'x', '--until', '2026-09-01']);
    expect(flags['until']).toBe('2026-09-01');
    expect(one(flags['until'])).toBe('2026-09-01');
  });

  it('gives the last value to a single-value flag typed twice', () => {
    // `--vault a --vault b` accumulates like any repeat; the sites that want
    // one value read the last, as argv readers do — not "neither", which is
    // what treating the array as absent would have silently meant.
    const { flags } = parseArgs(['--vault', 'first', '--vault', 'second', 'today']);
    expect(one(flags['vault'])).toBe('second');
  });

  it('keeps a repeated switch as plain true', () => {
    const { flags } = parseArgs(['ready', '--json', '--json']);
    expect(flags['json']).toBe(true);
  });

  it('does not let a bare repeat erase the values already given', () => {
    // `--takes` with no value used to overwrite the record with `true`, which
    // read downstream as "no flags at all" — and no flags clears the recipe.
    const trailing = parseArgs(['--takes', 'a:1', '--takes']);
    expect(list(trailing.flags['takes'])).toEqual(['a:1']);
    const leading = parseArgs(['--takes', '--makes', 'c:3', '--takes', 'a:1']);
    expect(list(leading.flags['takes'])).toEqual(['a:1']);
  });

  it('reads an absent or bare flag as an empty list', () => {
    const { flags } = parseArgs(['protocol', 'recipe', 'p1']);
    expect(list(flags['takes'])).toEqual([]);
    expect(one(flags['takes'])).toBeUndefined();
    expect(list(parseArgs(['--takes']).flags['takes'])).toEqual([]);
  });

  it('still refuses to let a switch swallow the verb', () => {
    const { positional, flags } = parseArgs(['--json', 'cultures']);
    expect(positional).toEqual(['cultures']);
    expect(flags['json']).toBe(true);
  });

  it('does not let --undo swallow the run id after it', () => {
    // `pt step --undo r1 s1` used to parse r1 as the value of --undo,
    // leaving one positional where tickRunStep expects two.
    expect(parseArgs(['step', '--undo', 'r1', 's1'])).toEqual({
      positional: ['step', 'r1', 's1'],
      flags: { undo: true },
    });
  });

  it('treats every documented switch as valueless', () => {
    for (const name of ['json', 'help', 'experiment', 'undated', 'preview', 'merge', 'yes', 'new', 'undo']) {
      const { positional, flags } = parseArgs([`--${name}`, 'verb']);
      expect(positional, `--${name} swallowed the word after it`).toEqual(['verb']);
      expect(flags[name]).toBe(true);
    }
  });

  it('reads a valued flag followed by another flag as a switch', () => {
    expect(parseArgs(['--vault', '--json'])).toEqual({
      positional: [],
      flags: { vault: true, json: true },
    });
  });
});
