/**
 * The vault is a line-based, indentation-sensitive text format. A name is
 * written into it as `name: <text>`, so a name containing a newline, or one
 * shaped like a field, or one shaped like a block header, is the classic way to
 * make a file say something its writer did not mean.
 *
 * These attempt it and check what comes back, rather than reading the
 * serialiser and concluding it is fine.
 */

import { describe, expect, it } from 'vitest';
import { openApp } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { MemoryVault } from '@store/vault.ts';
import { loadState } from '@store/store.ts';

const CLOCK = fixedClock('2026-08-13T09:00');

const HOSTILE: [string, string][] = [
  ['a newline', 'one\ntwo'],
  ['a field line', 'x\n  id: n999'],
  ['a block header', 'x\nproject injected\n  id: n998\n  name: Injected'],
  ['indentation', '\t\tdeeply indented'],
  ['a colon', 'ratio 1:1 EDC:NHS'],
  ['a trailing space', 'trailing space   '],
  ['a leading dash', '- not a list item'],
  ['carriage returns', 'one\r\ntwo'],
  ['a lone surrogate-ish string', 'emoji 😀 and 培養'],
  ['five thousand characters', 'x'.repeat(5000)],
];

describe('names that could break a line-based format', () => {
  for (const [label, name] of HOSTILE) {
    it(`survives a round trip: ${label}`, () => {
      const app = openApp(new MemoryVault(), CLOCK);
      const id = app.addProject(name).id;
      const stored = app.state.nodes[id]!.name;

      const reloaded = loadState(app.store.vault);
      const back = reloaded.nodes[id];

      expect(back, 'the node survived at all').toBeDefined();
      expect(back!.name, `stored "${JSON.stringify(stored)}"`).toBe(stored);
      // And nothing else appeared: an injected block would add a node.
      expect(Object.keys(reloaded.nodes)).toEqual(Object.keys(app.state.nodes));
    });
  }
});
