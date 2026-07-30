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
import { BACKUP_HEADERS, BACKUP_SHEET, backupGrid } from './backup.ts';

const HEALTH_FILL: Record<Health, string | undefined> = {
  not_begun: undefined,
  on_track: 'FF63BE7B',
  at_risk: 'FFFFC000',
  off_track: 'FFFF6B6B',
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
  'Kind',
  'Culture',
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
 * A one-page answer to "how is it going", for someone who is not going to open
 * the detail sheets.
 */
function writeSummary(book: Bookish, index: GraphIndex, today: string): void {
  const sheet = book.addWorksheet('Summary');
  const title = sheet.addRow([`${SUMMARY_MARKER} — generated ${today}`]);
  title.getCell(1).font = { bold: true, size: 13 };
  sheet.addRow([]);
  headerRow(sheet, SUMMARY_HEADERS);

  for (const project of rootProjects(index)) {
    const write = (node: Node, level: string, indent: number) => {
      const progress = progressOf(index, node.id) ?? { done: 0, total: 0 };
      const row = sheet.addRow([
        `${'    '.repeat(indent)}${node.name}`,
        level,
        progress.done,
        progress.total,
        progress.total ? progress.done / progress.total : 0,
        statusWord(index, node, today),
        node.health === 'not_begun' ? '' : node.health.replace('_', ' '),
        nextUp(index, node.id, today),
        datesOf(index, node.id),
      ]);
      row.getCell(5).numFmt = '0%';

      if (indent === 0) {
        for (let i = 1; i <= SUMMARY_HEADERS.length; i++) {
          row.getCell(i).font = { bold: true };
          row.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: RULE_FILL } };
        }
      }
      const fill = HEALTH_FILL[node.health];
      if (fill) row.getCell(7).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    };

    write(project, 'Project', 0);
    for (const milestone of childrenOf(index.state, project.id)) write(milestone, 'Milestone', 1);
    sheet.addRow([]);
  }

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

    // Hierarchy is filled down rather than left as a staircase: a manager who
    // sorts or filters in Excel should not end up with a row that says
    // "Peer review" and nothing about which project it belongs to.
    const write = (nodeId: string, milestone: string, goal: string) => {
      for (const child of childrenOf(state, nodeId)) {
        const isMilestone = child.kind === 'milestone';
        const isGoal = child.kind === 'goal';
        const milestoneName = isMilestone ? child.name : milestone;
        const goalName = isGoal ? child.name : isMilestone ? '' : goal;
        const progress = isContainerKind(child.kind) ? progressOf(index, child.id) : null;

        const row = sheet.addRow([
          child.seq,
          milestoneName,
          goalName,
          isContainerKind(child.kind) ? '' : child.name,
          child.status === 'done' ? 'Done' : child.status === 'dropped' ? 'Dropped' : '',
          child.doneAt ? encodePeriod(child.doneAt.slice(0, 10), child.donePrecision ?? 'day') : '',
          progress ? `${progress.done}/${progress.total}` : '',
          child.health === 'not_begun' ? '' : child.health.replace('_', ' '),
          child.plannedFor ?? '',
          child.tags.join(', '),
          child.notes ?? '',
          child.kind === 'experiment' ? 'experiment' : '',
          child.experiment ? encodeCulture(child.experiment) : '',
        ]);

        // The column this node's own name is in — where done and health are
        // marked, matching exactly where the importer looks for them.
        const own = isMilestone ? 2 : isGoal ? 3 : 4;
        if (child.status === 'done') row.getCell(own).font = { strike: true };
        const fill = HEALTH_FILL[child.health];
        if (fill) {
          row.getCell(own).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        }
        if (isMilestone) {
          for (let i = 1; i <= EXPORT_HEADERS.length; i++) {
            row.getCell(i).fill ??= { type: 'pattern', pattern: 'solid', fgColor: { argb: RULE_FILL } };
          }
        }

        write(child.id, milestoneName, goalName);
      }
    };

    write(project.id, '', '');

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
      { width: 11 },
      { width: 40 },
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
  if (def.mediaChangeEveryDays !== undefined) parts.push(`every=${def.mediaChangeEveryDays}`);
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
