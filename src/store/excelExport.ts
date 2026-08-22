/**
 * Excel export.
 *
 * Two audiences, which want different things from the same board.
 *
 * A **person** — a supervisor, a collaborator, a progress meeting — wants to
 * know what is done, what is late and what is next, without reading four
 * hundred rows. They get a Summary sheet first, and detail sheets whose
 * hierarchy columns are filled down so sorting or filtering in Excel does not
 * strand a row with no context.
 *
 * The **importer** wants to read it back without losing anything. That is why
 * completion is strikethrough and health is fill colour, matching exactly how
 * they are read, and why the machine-oriented columns (Kind, Culture) exist at
 * all — they sit at the far right, out of the way of anyone reading.
 *
 * Filling down is safe for the round trip: the importer emits a level only when
 * the name *changes*, so a repeated value is understood as continuation rather
 * than a second milestone of the same name.
 */

import type { ExperimentDef, Health, Node, State } from '../core/model.ts';
import { childrenOf, isContainerKind } from '../core/model.ts';
import { buildIndex, derivedStatus, isDone, progressOf, rootProjects } from '../core/graph.ts';
import type { GraphIndex } from '../core/graph.ts';
import { dateOf } from '../core/dates.ts';
import { encodePeriod } from '../core/periods.ts';
import type { BackupMeta, VaultFiles } from './backup.ts';
import type { StatementView } from '../commands/views.ts';
import { BACKUP_HEADERS, BACKUP_SHEET, backupGrid } from './backup.ts';

/**
 * The lab's own colour legend, which the workbook is expected to match:
 *
 *   green   on track for the deadline
 *   yellow  not begun, but will be done this quarter
 *   red     will not be done this quarter
 *   blue    off track
 *
 * with strikethrough for completed — so green struck through is "finished on
 * time" and blue struck through is "finished, but it went badly". That is the
 * pairing the two axes exist for: `health` is the colour and `status` is the
 * strike, and neither is derivable from the other.
 *
 * `healthFromColour` in store/excel.ts reads these back. The two must agree, or
 * a workbook stops surviving its own round trip.
 */
const HEALTH_FILL: Record<Health, string | undefined> = {
  not_begun: 'FFFFD966',
  on_track: 'FF63BE7B',
  at_risk: 'FFE06666',
  off_track: 'FF6FA8DC',
};

const HEADER_FILL = 'FFEFEFF3';
const RULE_FILL = 'FFF7F7F9';

/** Marks the generated sheet, so re-importing knows not to look for work in it. */
export const SUMMARY_MARKER = 'Protracker summary';

export const EXPORT_HEADERS = [
  'Seq',
  'Milestone',
  'Goal',
  'Task',
  'Status',
  'Completed',
  'Progress',
  'Health',
  'Planned',
  'Tags',
  'Notes',
  'Troubleshooting',
  'Kind',
  'Culture',
  'ID',
] as const;

const SUMMARY_HEADERS = [
  'Project / Milestone',
  'Level',
  'Done',
  'Total',
  'Complete',
  'Status',
  'Health',
  'Next up',
  'Dates',
] as const;

interface Cellish {
  value: unknown;
  font?: unknown;
  fill?: unknown;
  alignment?: unknown;
  numFmt?: unknown;
}
interface Rowish {
  getCell(index: number): Cellish;
  font?: unknown;
}
interface Sheetish {
  addRow(values: unknown[]): Rowish;
  columns: unknown;
  views: unknown;
  autoFilter: unknown;
  getRow(index: number): Rowish;
}
interface Bookish {
  addWorksheet(name: string, options?: unknown): Sheetish;
  xlsx: { writeBuffer(): Promise<unknown> };
}

/** Sheet names have characters Excel refuses, and a 31-character limit. */
function sheetName(name: string, taken: Set<string>): string {
  const base = (name.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Project').slice(0, 28);
  let candidate = base;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${base} ${i}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

function headerRow(sheet: Sheetish, headers: readonly string[]): Rowish {
  const row = sheet.addRow([...headers]);
  headers.forEach((_, i) => {
    row.getCell(i + 1).font = { bold: true };
    row.getCell(i + 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  });
  return row;
}

/** The first thing that could actually be worked on under a node. */
function nextUp(index: GraphIndex, id: string, today: string): string {
  for (const descendant of index.descendants.get(id) ?? []) {
    const node = index.state.nodes[descendant];
    if (!node || isContainerKind(node.kind)) continue;
    if (derivedStatus(index, descendant, today) === 'ready') return node.name;
  }
  return '';
}

/** Any dates worth a manager's attention: a planned date or a culture endpoint. */
function datesOf(index: GraphIndex, id: string): string {
  const parts: string[] = [];
  for (const descendant of [id, ...(index.descendants.get(id) ?? [])]) {
    const node = index.state.nodes[descendant];
    if (!node) continue;
    if (node.experiment?.seedingDate) {
      parts.push(`${node.name}: seeded ${node.experiment.seedingDate}`);
    }
  }
  return parts.slice(0, 2).join('; ');
}

function statusWord(index: GraphIndex, node: Node, today: string): string {
  if (isDone(index, node.id)) return 'Complete';
  const progress = progressOf(index, node.id);
  if (!progress || progress.total === 0) return 'Empty';
  if (progress.done > 0) return 'In progress';
  return derivedStatus(index, node.id, today) === 'blocked' ? 'Blocked' : 'Not started';
}

/**
 * One body row, and enough about where it came from to style it.
 *
 * Building rows as plain values first is what lets the same board go to an
 * .xlsx file and to a Google spreadsheet without two definitions of which
 * columns exist and in what order — the thing that would silently drift.
 */
export interface BodyRow {
  values: (string | number)[];
  /** Absent on the blank spacer rows. */
  node?: Node;
  /** 1-based column holding this node's own name, where done and health are marked. */
  ownColumn?: number;
  /** A rule across the whole row: projects on the summary, milestones on a project sheet. */
  banded?: boolean;
}

/**
 * A one-page answer to "how is it going", for someone who is not going to open
 * the detail sheets.
 */
export function summaryRows(index: GraphIndex, today: string): BodyRow[] {
  const out: BodyRow[] = [];

  for (const project of rootProjects(index)) {
    const write = (node: Node, level: string, indent: number) => {
      const progress = progressOf(index, node.id) ?? { done: 0, total: 0 };
      out.push({
        values: [
          `${'    '.repeat(indent)}${node.name}`,
          level,
          progress.done,
          progress.total,
          progress.total ? progress.done / progress.total : 0,
          statusWord(index, node, today),
          node.health === 'not_begun' ? '' : node.health.replace('_', ' '),
          nextUp(index, node.id, today),
          datesOf(index, node.id),
        ],
        node,
        ownColumn: 7,
        banded: indent === 0,
      });
    };

    write(project, 'Project', 0);
    for (const milestone of childrenOf(index.state, project.id)) write(milestone, 'Milestone', 1);
    out.push({ values: [] });
  }

  return out;
}

/**
 * What the colours mean, written into the workbook itself.
 *
 * A colour-coded sheet with no key is a sheet only its author can read, and this
 * one gets sent to people who were not in the room. Both strikethrough rows are
 * spelled out because "finished, but it went badly" is the pairing that most
 * often gets read as a mistake.
 */
function writeLegend(sheet: Sheetish): void {
  sheet.addRow([]);
  const heading = sheet.addRow(['Legend']);
  heading.getCell(1).font = { bold: true };

  const entries: { health: Health; strike: boolean; text: string }[] = [
    { health: 'on_track', strike: false, text: 'On track for the deadline' },
    // Deliberately not "…and will be done this quarter". Yellow is where a task
    // starts, and nothing here has worked out whether it will land in time —
    // saying so would be a forecast the app has no basis for.
    { health: 'not_begun', strike: false, text: 'Not begun' },
    { health: 'at_risk', strike: false, text: 'Will not be done this quarter' },
    { health: 'off_track', strike: false, text: 'Off track' },
    { health: 'on_track', strike: true, text: 'Completed, by the deadline' },
    { health: 'off_track', strike: true, text: 'Completed, but it went off track' },
  ];

  for (const entry of entries) {
    const row = sheet.addRow(['', entry.text]);
    const swatch = row.getCell(1);
    const fill = HEALTH_FILL[entry.health];
    if (fill) swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    if (entry.strike) {
      swatch.value = 'done';
      swatch.font = { strike: true };
    }
  }
}

function writeSummary(book: Bookish, index: GraphIndex, today: string): void {
  const sheet = book.addWorksheet('Summary');
  const title = sheet.addRow([`${SUMMARY_MARKER} — generated ${today}`]);
  title.getCell(1).font = { bold: true, size: 13 };
  sheet.addRow([]);
  headerRow(sheet, SUMMARY_HEADERS);

  for (const body of summaryRows(index, today)) {
    const row = sheet.addRow([...body.values]);
    if (!body.node) continue;
    row.getCell(5).numFmt = '0%';

    if (body.banded) {
      for (let i = 1; i <= SUMMARY_HEADERS.length; i++) {
        row.getCell(i).font = { bold: true };
        row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RULE_FILL } };
      }
    }
    const fill = HEALTH_FILL[body.node.health];
    if (fill) row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }

  writeLegend(sheet);

  sheet.columns = [
    { width: 42 },
    { width: 11 },
    { width: 7 },
    { width: 7 },
    { width: 10 },
    { width: 13 },
    { width: 11 },
    { width: 30 },
    { width: 34 },
  ];
  sheet.views = [{ state: 'frozen', ySplit: 3 }];
}

/**
 * The lossless half of the workbook.
 *
 * Hidden, because a manager opening this has no use for it and every reason to
 * be confused by it — but present, so that "Export to Excel" is a real backup
 * and not just a report. Everything above this line is a rendering; this is the
 * vault.
 */
/**
 * Every row of one project's sheet, as a staircase.
 *
 * Each name is written once, on its own row, and the rows beneath it leave that
 * column empty — so the hierarchy reads as indentation rather than as the same
 * milestone repeated down forty rows. It survives the round trip because the
 * importer only starts a new level when it sees a name, and treats an empty
 * cell as "still the one above" (see the milestone/goal tracking in
 * `readWorkbook`). `reconcile` carries the last-seen names forward for the same
 * reason, so a task typed straight under a goal still finds its parent.
 */
export function projectRows(index: GraphIndex, project: Node): BodyRow[] {
  const out: BodyRow[] = [];

  const write = (nodeId: string) => {
    for (const child of childrenOf(index.state, nodeId)) {
      const isMilestone = child.kind === 'milestone';
      const isGoal = child.kind === 'goal';
      const progress = isContainerKind(child.kind) ? progressOf(index, child.id) : null;

      out.push({
        values: [
          child.seq,
          isMilestone ? child.name : '',
          isGoal ? child.name : '',
          isContainerKind(child.kind) ? '' : child.name,
          child.status === 'done' ? 'Done' : child.status === 'dropped' ? 'Dropped' : '',
          child.doneAt ? encodePeriod(child.doneAt.slice(0, 10), child.donePrecision ?? 'day') : '',
          progress ? `${progress.done}/${progress.total}` : '',
          child.health === 'not_begun' ? '' : child.health.replace('_', ' '),
          child.plannedFor ?? '',
          child.tags.join(', '),
          child.notes ?? '',
          child.troubleshooting ?? '',
          child.kind === 'experiment' ? 'experiment' : '',
          child.experiment ? encodeCulture(child.experiment) : '',
          // Identity, so an edit made in the spreadsheet can be matched back to
          // the thing it edited. Without it a rename is indistinguishable from
          // a delete and a create, and there is no safe way to merge.
          child.id,
        ],
        node: child,
        // Where the importer looks for done and health: the column this node's
        // own name is in.
        ownColumn: isMilestone ? 2 : isGoal ? 3 : 4,
        banded: isMilestone,
      });

      write(child.id);
    }
  };

  write(project.id);
  return out;
}

/**
 * The whole board as plain grids of text — what a Google spreadsheet wants,
 * where there are no fonts or fills to carry meaning.
 *
 * Because completion is strikethrough and health is fill colour in the .xlsx,
 * neither survives a plain grid; the Status and Health columns carry both in
 * words, which is why they exist. This is the readable half of a Sheets
 * backup, and the vault grid alongside it is the half that restores.
 */
export function readableGrids(state: State, today: string): { title: string; rows: string[][] }[] {
  const index = buildIndex(state);
  const taken = new Set<string>(['summary', BACKUP_SHEET.toLowerCase()]);
  const text = (row: BodyRow) =>
    row.values.map((value) => (typeof value === 'number' ? String(value) : value));

  const sheets: { title: string; rows: string[][] }[] = [
    {
      title: 'Summary',
      rows: [
        [`${SUMMARY_MARKER} — generated ${today}`],
        [],
        [...SUMMARY_HEADERS],
        ...summaryRows(index, today).map((row) =>
          row.node
            ? text(row).map((value, i) => (i === 4 ? `${Math.round(Number(value) * 100)}%` : value))
            : [],
        ),
      ],
    },
  ];

  for (const project of rootProjects(index)) {
    sheets.push({
      title: sheetName(project.name, taken),
      rows: [
        ['Project name', project.name],
        [],
        [...EXPORT_HEADERS],
        ...projectRows(index, project).map(text),
      ],
    });
  }

  return sheets;
}

function writeVaultSheet(book: Bookish, files: VaultFiles, meta: BackupMeta): void {
  const sheet = book.addWorksheet(BACKUP_SHEET, { state: 'hidden' });
  const rows = backupGrid(files, meta);

  for (const row of rows) sheet.addRow([...row]);
  sheet.getRow(1).getCell(1).font = { bold: true };
  headerFont(sheet, rows.findIndex((r) => r[0] === BACKUP_HEADERS[0]) + 1);
  sheet.columns = [{ width: 26 }, { width: 6 }, { width: 6 }, { width: 18 }, { width: 60 }];
}

function headerFont(sheet: Sheetish, rowNumber: number): void {
  if (rowNumber < 1) return;
  const row = sheet.getRow(rowNumber);
  for (let i = 1; i <= BACKUP_HEADERS.length; i++) {
    row.getCell(i).font = { bold: true };
    row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  }
}

export function writeWorkbook(
  book: Bookish,
  state: State,
  today: string,
  backup?: { files: VaultFiles; meta: BackupMeta },
): void {
  const index = buildIndex(state);
  const taken = new Set<string>(['summary', BACKUP_SHEET.toLowerCase()]);

  writeSummary(book, index, today);

  for (const project of rootProjects(index)) {
    const sheet = book.addWorksheet(sheetName(project.name, taken));

    // A preamble the importer reads back, so a truncated tab name does not
    // rename the project on the way home.
    const title = sheet.addRow(['Project name', project.name]);
    title.getCell(1).font = { bold: true };
    sheet.addRow([]);
    headerRow(sheet, EXPORT_HEADERS);

    for (const body of projectRows(index, project)) {
      const row = sheet.addRow([...body.values]);
      if (!body.node || !body.ownColumn) continue;

      if (body.node.status === 'done') row.getCell(body.ownColumn).font = { strike: true };
      const fill = HEALTH_FILL[body.node.health];
      if (fill) {
        row.getCell(body.ownColumn).fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: fill },
        };
      }
      if (body.banded) {
        for (let i = 1; i <= EXPORT_HEADERS.length; i++) {
          row.getCell(i).fill ??= { type: 'pattern', pattern: 'solid', fgColor: { argb: RULE_FILL } };
        }
      }
    }

    sheet.columns = [
      { width: 6 },
      { width: 26 },
      { width: 26 },
      { width: 34 },
      { width: 10 },
      { width: 12 },
      { width: 10 },
      { width: 11 },
      { width: 12 },
      { width: 18 },
      { width: 44 },
      { width: 44 },
      { width: 11 },
      { width: 40 },
      { width: 8 },
    ];
    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    // Filter handles on the header, because the first thing anyone does with a
    // spreadsheet is filter it.
    sheet.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: EXPORT_HEADERS.length } };
  }

  if (backup) writeVaultSheet(book, backup.files, backup.meta);
}

export async function exportWorkbook(
  state: State,
  today = dateOf(new Date().toISOString()),
  backup?: { files: VaultFiles; meta: BackupMeta },
): Promise<Uint8Array> {
  const ExcelJS = await import('exceljs');
  const book = new ExcelJS.default.Workbook();
  book.creator = 'Protracker';
  book.created = new Date();
  writeWorkbook(book as unknown as Bookish, state, today, backup);
  return new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
}

/**
 * A cell culture definition as one readable cell.
 *
 *   samples=24; cells=50000; line=hMSC; seed=2026-08-03; days=21; every=2;
 *   phases=Proliferation@0,Differentiation@7; endpoint=Fix and stain
 *
 * Compact enough to sit in a column, and obvious enough that someone editing
 * the workbook by hand can change it without documentation.
 */
export function encodeCulture(def: ExperimentDef): string {
  const parts: string[] = [`samples=${def.sampleCount}`];
  if (def.cellsPerScaffold !== undefined) parts.push(`cells=${def.cellsPerScaffold}`);
  if (def.cellLine) parts.push(`line=${def.cellLine}`);
  if (def.scaffoldTypeName) parts.push(`scaffold=${def.scaffoldTypeName}`);
  if (def.scaffoldsExpected) parts.push(`expected=${def.scaffoldsExpected}`);
  if (def.seedingDate) parts.push(`seed=${def.seedingDate}`);
  parts.push(`days=${def.durationDays}`);
  if (def.mediaPhases.length) {
    parts.push(`phases=${def.mediaPhases.map((p) => `${p.name}@${p.startDay}`).join(',')}`);
  }
  if (def.endpoint) parts.push(`endpoint=${def.endpoint}`);
  return parts.join('; ');
}

/** A filename that sorts sensibly and says what it is. */
export function exportFilename(today: string): string {
  return `Protracker ${today}.xlsx`;
}

// ---------------------------------------------------------------- statement

/**
 * A statement of work as a workbook: what was done, by project, between two
 * days — the record an invoice is written from. Two sheets: the summary a
 * client reads, and the detail a question about it is answered from. No
 * prices, deliberately: the notebook keeps the record; whoever bills decides
 * what a day is worth.
 */
export async function exportStatement(statement: StatementView): Promise<Uint8Array> {
  const ExcelJS = await import('exceljs');
  const book = new ExcelJS.default.Workbook();
  book.creator = 'Protracker';
  book.created = new Date();
  writeStatement(book as unknown as Bookish, statement);
  return new Uint8Array((await book.xlsx.writeBuffer()) as ArrayBuffer);
}

export function statementFilename(from: string, to: string): string {
  return `Protracker statement ${from} to ${to}.xlsx`;
}

export function writeStatement(book: Bookish, statement: StatementView): void {
  const summary = book.addWorksheet('Statement');
  summary.addRow([`Statement of work, ${statement.from} to ${statement.to}`]);
  summary.addRow([`${statement.days} day${statement.days === 1 ? '' : 's'} with recorded work`]);
  summary.addRow([]);
  headerRow(summary, ['Project', 'Days worked', 'Completed', 'Journal entries', 'Runs started', 'Batches made']);
  for (const project of statement.projects) {
    summary.addRow([project.name, project.days, project.completed, project.notes, project.runs, project.batches]);
  }
  summary.columns = [{ width: 44 }, { width: 13 }, { width: 12 }, { width: 16 }, { width: 13 }, { width: 14 }];

  const detail = book.addWorksheet('Detail');
  headerRow(detail, ['Date', 'Time', 'Project', 'Where', 'Kind', 'What']);
  for (const project of statement.projects) {
    for (const entry of project.entries) {
      detail.addRow([
        entry.at.slice(0, 10),
        entry.at.slice(11, 16),
        project.name,
        entry.parentPath ?? '',
        entry.kind,
        `${entry.text}${entry.period ? ` (${entry.period})` : ''}`,
      ]);
    }
  }
  detail.columns = [{ width: 12 }, { width: 7 }, { width: 30 }, { width: 44 }, { width: 12 }, { width: 80 }];
  detail.views = [{ state: 'frozen', ySplit: 1 }];
}
