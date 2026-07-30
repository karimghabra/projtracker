/**
 * Pushing to a spreadsheet and pulling back, against a fake spreadsheet.
 *
 * The real transport is four REST calls and a signed JWT with no decisions in
 * it; everything worth getting wrong is here — which tabs get written, which
 * get removed, what happens to somebody else's tab, and whether the vault that
 * comes back is the vault that went out.
 */

import { describe, expect, it } from 'vitest';
import { BACKUP_SHEET, snapshotVault } from '@store/backup.ts';
import { readableGrids } from '@store/excelExport.ts';
import { MemoryVault } from '@store/vault.ts';
import { App } from '@commands/app.ts';
import { fixedClock } from '@core/dates.ts';
import { pullBackup, pushBackup, readReadableTabs, untouchedSince } from '@sync/backupSync.ts';
import type { SheetsTransport } from '@sync/sheets.ts';
import { parseServiceAccount, parseSpreadsheetId } from '@sync/sheets.ts';
import { harness, sampleBoard, T0 } from './helpers.ts';

const META = { generatedAt: '2026-07-30T09:00', version: '1.4.0' };

/** A spreadsheet that is a Map. Enough to test every decision the sync makes. */
class FakeSheets implements SheetsTransport {
  readonly grids = new Map<string, string[][]>();
  readonly log: string[] = [];

  constructor(private readonly name = 'Lab backup') {}

  async title() {
    return this.name;
  }
  async tabs() {
    return [...this.grids.keys()];
  }
  async writeTab(title: string, rows: string[][]) {
    this.log.push(`write ${title}`);
    this.grids.set(title, rows.map((row) => [...row]));
  }
  async readTab(title: string) {
    return (this.grids.get(title) ?? []).map((row) => [...row]);
  }
  async deleteTab(title: string) {
    this.log.push(`delete ${title}`);
    this.grids.delete(title);
  }
}

function board() {
  const h = harness();
  sampleBoard(h);
  return h;
}

async function push(sheets: FakeSheets, h: ReturnType<typeof board>) {
  return pushBackup(sheets, {
    files: h.app.backupFiles(),
    meta: META,
    readable: readableGrids(h.app.state, '2026-07-30'),
  });
}

describe('pushing a board to a spreadsheet', () => {
  it('writes a readable tab per project, plus the vault', async () => {
    const sheets = new FakeSheets();
    const report = await push(sheets, board());

    expect(report.written).toContain('Summary');
    expect(report.written).toContain('Tendon Study');
    expect(report.written).toContain(BACKUP_SHEET);
    expect(report.spreadsheet).toBe('Lab backup');
    expect(report.files).toBeGreaterThan(2);
  });

  it('says in words what the workbook says in strikethrough and colour', async () => {
    const h = board();
    const task = h.app.sheet().find((r) => r.kind === 'task')!;
    h.app.complete(task.id, 'Q1 2026');
    h.app.updateNode(task.id, { health: 'at_risk' });

    const sheets = new FakeSheets();
    await push(sheets, h);

    const grid = sheets.grids.get('Tendon Study')!;
    const row = grid.find((cells) => cells[3] === task.task)!;
    // A plain grid has no fonts or fills, so completion and health have to be
    // legible as text or they are not there at all.
    expect(row[4]).toBe('Done');
    // The sortable, locale-proof form, because this column is also what the
    // importer reads back.
    expect(row[5]).toBe('2026-Q1');
    expect(row[7]).toBe('at risk');
  });

  it('shows percentages as percentages, not as 0.6666666666', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);

    const summary = sheets.grids.get('Summary')!;
    for (const row of summary.slice(3)) {
      if (row[4]) expect(row[4]).toMatch(/^\d+%$/);
    }
  });

  it('is idempotent: pushing twice leaves the same spreadsheet', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);
    const first = new Map([...sheets.grids].map(([k, v]) => [k, JSON.stringify(v)]));

    await push(sheets, h);
    expect(new Map([...sheets.grids].map(([k, v]) => [k, JSON.stringify(v)]))).toEqual(first);
  });

  it('removes the tab of a project that no longer exists', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);
    expect(sheets.grids.has('Tendon Study')).toBe(true);

    h.app.deleteNode(h.app.tree()[0]!.id);
    h.app.addProject('Something else');
    const report = await push(sheets, h);

    expect(report.removed).toEqual(['Tendon Study']);
    expect(sheets.grids.has('Something else')).toBe(true);
  });

  it('leaves a tab somebody else made completely alone', async () => {
    const sheets = new FakeSheets();
    sheets.grids.set('Reagent orders', [['Item', 'Cost'], ['Collagen', '210']]);

    const report = await push(sheets, board());

    expect(report.removed).toEqual([]);
    expect(sheets.grids.get('Reagent orders')).toEqual([['Item', 'Cost'], ['Collagen', '210']]);
  });

  it('shrinks the vault tab when the vault shrinks', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);
    const before = sheets.grids.get(BACKUP_SHEET)!.length;

    h.app.deleteNode(h.app.tree()[0]!.id);
    await push(sheets, h);

    // Rewritten wholesale rather than appended to, so an old backup cannot
    // leave rows behind that a restore would then believe.
    expect(sheets.grids.get(BACKUP_SHEET)!.length).toBeLessThan(before);
  });
});

describe('pulling a board back', () => {
  it('rebuilds a vault identical to the one that was pushed', async () => {
    const h = board();
    h.app.capture('A note, so the journal is in there too.');
    const before = h.app.backupFiles();

    const sheets = new FakeSheets();
    await push(sheets, h);

    const read = await pullBackup(sheets);
    expect(read.problems).toEqual([]);
    expect(read.files).toEqual(before);
  });

  it('restores into an app that agrees with the original', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);

    const fresh = new MemoryVault();
    const app = new App(fresh, fixedClock(T0));
    app.restoreBackup((await pullBackup(sheets)).files);

    expect(app.sheet().map((r) => r.task)).toEqual(h.app.sheet().map((r) => r.task));
    expect(snapshotVault(fresh)).toEqual(h.app.backupFiles());
  });

  it('says plainly when the spreadsheet is not a Protracker backup', async () => {
    const sheets = new FakeSheets();
    sheets.grids.set('Sheet1', [['Some other spreadsheet']]);
    await expect(pullBackup(sheets)).rejects.toThrow(/has no "Vault" tab/);
  });

  it('reports a damaged backup instead of restoring it', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);

    const grid = sheets.grids.get(BACKUP_SHEET)!;
    const row = grid.find((cells) => cells[0]?.startsWith('projects/'))!;
    row[4] = `|${'tampered\n'}|`;

    const read = await pullBackup(sheets);
    expect(read.problems.join(' ')).toMatch(/does not match its checksum/);
  });

  it('survives a spreadsheet that dropped trailing empty cells', async () => {
    const h = board();
    const sheets = new FakeSheets();
    await push(sheets, h);

    // Sheets omits trailing empties on read; the vault rows must not depend on
    // them being there.
    const grid = sheets.grids.get(BACKUP_SHEET)!;
    sheets.grids.set(
      BACKUP_SHEET,
      grid.map((row) => {
        const copy = [...row];
        while (copy.length && copy[copy.length - 1] === '') copy.pop();
        return copy;
      }),
    );

    expect((await pullBackup(sheets)).problems).toEqual([]);
  });
});

describe('noticing that somebody edited the spreadsheet', () => {
  it('says the sheet is untouched right after a push', async () => {
    const sheets = new FakeSheets();
    const report = await push(sheets, board());

    // The trap this is really testing: Sheets drops trailing empty cells and
    // rows on the way out, so a naive comparison calls every tab edited the
    // first time it is read back.
    for (const [title, rows] of sheets.grids) {
      sheets.grids.set(
        title,
        rows.map((row) => {
          const copy = [...row];
          while (copy.length && copy[copy.length - 1] === '') copy.pop();
          return copy;
        }),
      );
    }

    expect(await untouchedSince(sheets, report.fingerprints)).toEqual({ ok: true, edited: [] });
  });

  it('names the tab somebody typed in', async () => {
    const h = board();
    const sheets = new FakeSheets();
    const report = await push(sheets, h);

    const grid = sheets.grids.get('Tendon Study')!;
    grid[4] = [...grid[4]!];
    grid[4]![10] = 'a note typed on a phone';

    const result = await untouchedSince(sheets, report.fingerprints);
    expect(result.ok).toBe(false);
    expect(result.edited).toEqual(['Tendon Study']);
  });

  it('treats a deleted tab as a change, and a loud one', async () => {
    const sheets = new FakeSheets();
    const report = await push(sheets, board());
    sheets.grids.delete('Tendon Study');

    expect((await untouchedSince(sheets, report.fingerprints)).edited).toEqual(['Tendon Study']);
  });

  it('ignores a tab it never wrote', async () => {
    const sheets = new FakeSheets();
    const report = await push(sheets, board());
    sheets.grids.set('Reagent orders', [['Item'], ['Collagen']]);

    expect((await untouchedSince(sheets, report.fingerprints)).ok).toBe(true);
  });

  it('has nothing to check before the first push', async () => {
    expect(await untouchedSince(new FakeSheets(), {})).toEqual({ ok: true, edited: [] });
  });

  it('reads back only the readable tabs, never the vault', async () => {
    const h = board();
    const sheets = new FakeSheets();
    const report = await push(sheets, h);

    const grids = await readReadableTabs(sheets, Object.keys(report.fingerprints));
    expect(grids.map((g) => g.title)).toEqual(['Summary', 'Tendon Study']);
    expect(grids.map((g) => g.title)).not.toContain(BACKUP_SHEET);
  });
});

describe('reading what the user pastes in', () => {
  it('takes a spreadsheet link or a bare id', () => {
    const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(parseSpreadsheetId(id)).toBe(id);
    expect(parseSpreadsheetId('  ')).toBeNull();
    expect(parseSpreadsheetId('not a link')).toBeNull();
  });

  it('explains what is wrong with the key file rather than failing later', () => {
    expect(() => parseServiceAccount('nonsense')).toThrow(/not a JSON file/);
    expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/not a service account/);
    expect(() => parseServiceAccount('{"private_key":"-----BEGIN PRIVATE KEY-----"}')).toThrow(
      /no client_email/,
    );
    expect(() => parseServiceAccount('{"client_email":"a@b.iam.gserviceaccount.com"}')).toThrow(
      /no private_key/,
    );
  });

  it('unescapes a private key that came through a text box', () => {
    const account = parseServiceAccount(
      JSON.stringify({
        type: 'service_account',
        client_email: 'backup@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n',
      }),
    );
    expect(account.privateKey).toContain('\n');
    expect(account.privateKey).not.toContain('\\n');
  });
});
