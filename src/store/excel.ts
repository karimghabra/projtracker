/**
 * Excel import.
 *
 * Kept as an interchange path, not a way of life: it exists so a tracker that
 * already lives in a workbook can be brought across once. Afterwards the vault
 * is the truth.
 *
 * Columns are matched by header *name*, so a sparse sheet with only
 * Project/Milestone/Goal/Task is valid. Import is two-phase — a preview says
 * exactly what will happen before anything is written — because an import that
 * silently merges two unrelated trackers is very hard to unpick.
 *
 * Parsing is separated from applying: `readWorkbook` produces plain data and
 * touches nothing, and `applyImport` is an ordinary command-layer transaction.
 */

import type { Health } from '../core/model.ts';
import type { BackupRead } from './backup.ts';
import { BACKUP_MARKER, readBackupGrid } from './backup.ts';

export type RowKind = 'project' | 'milestone' | 'goal' | 'task' | 'experiment';

export interface CultureSpec {
  sampleCount: number;
  cellsPerScaffold?: number;
  cellLine?: string;
  scaffoldTypeName?: string;
  scaffoldsExpected?: string;
  seedingDate?: string;
  durationDays: number;
  mediaChangeEveryDays?: number;
  mediaPhases: { name: string; startDay: number }[];
  endpoint?: string;
}

/** The inverse of `encodeCulture`. Anything unparseable is simply left out. */
export function decodeCulture(text: string): CultureSpec | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  const fields = new Map<string, string>();
  for (const part of trimmed.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    fields.set(part.slice(0, at).trim().toLowerCase(), part.slice(at + 1).trim());
  }
  if (fields.size === 0) return undefined;

  const num = (key: string) => {
    const raw = fields.get(key);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const phases = (fields.get('phases') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const at = entry.lastIndexOf('@');
      if (at < 0) return null;
      const day = Number(entry.slice(at + 1));
      return Number.isFinite(day) ? { name: entry.slice(0, at).trim(), startDay: day } : null;
    })
    .filter((p): p is { name: string; startDay: number } => p !== null);

  return {
    sampleCount: num('samples') ?? 0,
    cellsPerScaffold: num('cells'),
    cellLine: fields.get('line') || undefined,
    scaffoldTypeName: fields.get('scaffold') || undefined,
    scaffoldsExpected: fields.get('expected') || undefined,
    seedingDate: fields.get('seed') || undefined,
    durationDays: num('days') ?? 21,
    mediaChangeEveryDays: num('every'),
    mediaPhases: phases,
    endpoint: fields.get('endpoint') || undefined,
  };
}

export interface ImportRow {
  kind: RowKind;
  name: string;
  /**
   * The node this row came from, when the sheet was written by Protracker.
   * Empty on a row somebody typed in by hand, which is what makes it new.
   */
  id?: string;
  /** Whatever was in the Completed column, verbatim, for the caller to parse. */
  completedText?: string;
  /** Explicitly abandoned, as distinct from merely unfinished. */
  dropped?: boolean;
  /** Present when the row carried a cell culture definition. */
  culture?: CultureSpec;
  seq?: number;
  notes?: string;
  done: boolean;
  health: Health;
  plannedFor?: string;
  tags: string[];
  /** 1-based row number in the sheet, for the review list. */
  line: number;
}

export interface ImportSheet {
  /** What the project will be called. */
  name: string;
  sheetName: string;
  rows: ImportRow[];
}

export interface ImportReview {
  sheet: string;
  line?: number;
  message: string;
}

export interface ImportPlan {
  sheets: ImportSheet[];
  /** Sheets with no recognisable header — listed, never silently dropped. */
  skipped: { sheet: string; reason: string }[];
  review: ImportReview[];
}

/** Header names we understand, lower-cased and stripped of punctuation. */
const HEADERS: Record<string, keyof ColumnMap> = {
  project: 'project',
  milestone: 'milestone',
  phase: 'milestone',
  goal: 'goal',
  objective: 'goal',
  task: 'task',
  step: 'task',
  action: 'task',
  seq: 'seq',
  order: 'seq',
  no: 'seq',
  num: 'seq',
  notes: 'notes',
  note: 'notes',
  comment: 'notes',
  comments: 'notes',
  status: 'status',
  health: 'health',
  deadline: 'planned',
  due: 'planned',
  date: 'planned',
  planned: 'planned',
  tags: 'tags',
  tag: 'tags',
  kind: 'kind',
  type: 'kind',
  completed: 'completed',
  completedon: 'completed',
  completedin: 'completed',
  donedate: 'completed',
  datecompleted: 'completed',
  culture: 'culture',
  experiment: 'culture',
  id: 'id',
  nodeid: 'id',
};

interface ColumnMap {
  project?: number;
  milestone?: number;
  goal?: number;
  task?: number;
  seq?: number;
  notes?: number;
  status?: number;
  health?: number;
  planned?: number;
  tags?: number;
  kind?: number;
  culture?: number;
  completed?: number;
  id?: number;
}

function normalise(value: unknown): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Fill colour is a *health* axis, never a status.
 *
 * The legend pairs both green and blue with strikethrough — "off track but
 * completed" is a real combination — so colour cannot be allowed to decide
 * whether something is done.
 *
 * The legend itself, which `HEALTH_FILL` in store/excelExport.ts writes and this
 * reads back:
 *
 *   green   on track            yellow  not begun, but will make the quarter
 *   blue    off track           red     will not be done this quarter
 *
 * Classified by which channel leads rather than by matching exact colours,
 * because a workbook filled in by hand over two years has a dozen greens in it.
 */
function healthFromColour(argb: string | undefined): Health {
  if (!argb) return 'not_begun';
  const hex = argb.length === 8 ? argb.slice(2) : argb;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return 'not_begun';

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 24) return 'not_begun'; // grey or white: no statement made

  if (b === max && b > r) return 'off_track';
  if (g === max && g > r) return 'on_track';
  // Red leads. Yellow and amber carry a strong green channel too; a red that
  // does not is the "will not be done" red.
  if (r === max) return g >= r * 0.55 && b < r * 0.5 ? 'not_begun' : 'at_risk';
  return 'not_begun';
}

function healthFromText(text: string): Health | undefined {
  const value = normalise(text);
  if (!value) return undefined;
  if (value.includes('ontrack') || value === 'green' || value === 'good') return 'on_track';
  if (value.includes('offtrack') || value === 'blue') return 'off_track';
  if (value.includes('atrisk') || value === 'red' || value.includes('wontfinish')) return 'at_risk';
  if (
    value.includes('notbegun') ||
    value.includes('notstarted') ||
    value === 'yellow' ||
    value === 'amber'
  ) {
    return 'not_begun';
  }
  return undefined;
}

function isDoneText(text: string): boolean {
  const value = normalise(text);
  return value === 'done' || value === 'complete' || value === 'completed' || value === 'x' || value === 'yes';
}

function toDate(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  return undefined;
}

/** Minimal shapes from exceljs, so this module does not depend on its types. */
interface Cellish {
  value: unknown;
  text?: string;
  font?: { strike?: boolean };
  fill?: { fgColor?: { argb?: string } };
}
interface Rowish {
  number: number;
  getCell(column: number): Cellish;
  cellCount: number;
  eachCell(options: { includeEmpty: boolean }, fn: (cell: Cellish, column: number) => void): void;
}
interface Sheetish {
  name: string;
  rowCount: number;
  getRow(index: number): Rowish;
}
interface Workbookish {
  worksheets: Sheetish[];
}

function cellText(cell: Cellish | undefined): string {
  if (!cell) return '';
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null) {
    // Rich text and hyperlink cells carry their readable form in `text`.
    const rich = value as { text?: string; richText?: { text: string }[]; result?: unknown };
    if (Array.isArray(rich.richText)) return rich.richText.map((part) => part.text).join('').trim();
    if (typeof rich.text === 'string') return rich.text.trim();
    if (rich.result !== undefined) return String(rich.result).trim();
    if (value instanceof Date) return String(cell.text ?? '').trim();
  }
  return String(value).trim();
}

/** Find the header row, and which column is which. */
function findHeader(sheet: Sheetish): { row: number; columns: ColumnMap } | null {
  const limit = Math.min(sheet.rowCount, 20);
  for (let index = 1; index <= limit; index++) {
    const row = sheet.getRow(index);
    const columns: ColumnMap = {};
    let hits = 0;

    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const key = HEADERS[normalise(cellText(cell))];
      if (key && columns[key] === undefined) {
        columns[key] = column;
        hits += 1;
      }
    });

    // Two recognised headers is enough; a sheet with only Task and Notes is
    // still a tracker, and demanding the full set would reject real files.
    if (hits >= 2 && (columns.task !== undefined || columns.goal !== undefined)) {
      return { row: index, columns };
    }
  }
  return null;
}

/** The project name from the preamble above the header, if there is one. */
function preambleName(sheet: Sheetish, headerRow: number): string | undefined {
  for (let index = 1; index < headerRow; index++) {
    const row = sheet.getRow(index);
    let found: string | undefined;
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      if (found) return;
      if (normalise(cellText(cell)).startsWith('projectname')) {
        found = cellText(row.getCell(column + 1)) || undefined;
      }
    });
    if (found) return found;
  }
  return undefined;
}

/**
 * The vault sheet, if the workbook carries one.
 *
 * Separate from `readWorkbook` because it answers a different question. The
 * importer merges rows into whatever is already there; this is the raw vault,
 * and restoring it replaces everything. Confusing the two would be the worst
 * kind of bug, so they do not share a code path.
 */
export function readBackupSheet(workbook: Workbookish): BackupRead | null {
  const sheet = workbook.worksheets.find(
    (candidate) => cellText(candidate.getRow(1).getCell(1)) === BACKUP_MARKER,
  );
  if (!sheet) return null;

  const grid: string[][] = [];
  for (let index = 1; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index);
    // Trimming is safe here only because every content cell is fenced; the
    // fence characters are the outer ones, so the payload is never touched.
    grid.push([1, 2, 3, 4, 5].map((column) => cellText(row.getCell(column))));
  }
  return readBackupGrid(grid);
}

export function readWorkbook(workbook: Workbookish): ImportPlan {
  const plan: ImportPlan = { sheets: [], skipped: [], review: [] };
  const namesSeen = new Map<string, number>();

  for (const sheet of workbook.worksheets) {
    // Our own summary sheet is generated from the others; reading it back would
    // be reading our own arithmetic as if it were data.
    if (cellText(sheet.getRow(1).getCell(1)).startsWith('Protracker summary')) {
      plan.skipped.push({ sheet: sheet.name, reason: 'generated summary — nothing to import' });
      continue;
    }

    // The vault sheet is the backup, not a source of rows. Restoring from it
    // is a separate, deliberate act — see `readBackupSheet`.
    if (cellText(sheet.getRow(1).getCell(1)) === BACKUP_MARKER) {
      plan.skipped.push({ sheet: sheet.name, reason: 'backup of the vault — restore it instead' });
      continue;
    }

    const header = findHeader(sheet);
    if (!header) {
      plan.skipped.push({ sheet: sheet.name, reason: 'no recognisable header row' });
      continue;
    }

    const { columns } = header;
    const rows: ImportRow[] = [];
    let projectName = preambleName(sheet, header.row) ?? sheet.name;

    // Real trackers come in two styles: blank continuation cells, and the full
    // path repeated on every row. Some use both in one sheet, and a row that
    // names a goal *and* its first task is entirely normal. So rather than
    // classifying a row as one thing, track the current milestone and goal and
    // emit whichever levels this row introduces.
    let currentMilestone = '';
    let currentGoal = '';

    for (let index = header.row + 1; index <= sheet.rowCount; index++) {
      const row = sheet.getRow(index);
      const at = (key: keyof ColumnMap) =>
        columns[key] === undefined ? '' : cellText(row.getCell(columns[key]!));
      const cellOf = (key: keyof ColumnMap) =>
        columns[key] === undefined ? undefined : row.getCell(columns[key]!);

      const project = at('project');
      const milestone = at('milestone');
      const goal = at('goal');
      const task = at('task');
      if (!project && !milestone && !goal && !task) continue;
      if (project) projectName = project;

      const seqText = at('seq');
      const seq = seqText && Number.isFinite(Number(seqText)) ? Number(seqText) : undefined;
      if (seqText && seq === undefined) {
        plan.review.push({ sheet: sheet.name, line: index, message: `"${seqText}" is not a number; order ignored.` });
      }

      const plannedRaw = columns.planned === undefined ? undefined : row.getCell(columns.planned).value;
      const plannedFor = toDate(plannedRaw);
      if (plannedRaw && !plannedFor) {
        plan.review.push({
          sheet: sheet.name,
          line: index,
          message: `"${cellText(row.getCell(columns.planned!))}" is not a date; kept out of the date column.`,
        });
      }

      // The deepest thing this row introduces owns the row's own attributes;
      // a container mentioned in passing gets only its name.
      const deepest: RowKind = task ? 'task' : goal ? 'goal' : 'milestone';
      const culture = decodeCulture(at('culture'));
      const isExperiment = normalise(at('kind')) === 'experiment' || culture !== undefined;
      const push = (kind: RowKind, name: string, key: keyof ColumnMap) => {
        const cell = cellOf(key);
        const own = kind === deepest;
        rows.push({
          kind: own && kind === 'task' && isExperiment ? 'experiment' : kind,
          name,
          id: own ? at('id').trim() || undefined : undefined,
          completedText: own ? at('completed').trim() || undefined : undefined,
          culture: own ? culture : undefined,
          seq: own ? seq : undefined,
          notes: own ? at('notes') || undefined : undefined,
          done: own
            ? cell?.font?.strike === true ||
              isDoneText(at('status')) ||
              at('completed').trim() !== ''
            : false,
          // Dropped is not "not done": it is a decision, and losing it on the
          // way back in would quietly resurrect abandoned work.
          dropped: own ? normalise(at('status')) === 'dropped' : false,
          health: own
            ? (healthFromText(at('health')) ?? healthFromColour(cell?.fill?.fgColor?.argb))
            : 'not_begun',
          plannedFor: own ? plannedFor : undefined,
          tags: own ? at('tags').split(',').map((t) => t.trim()).filter(Boolean) : [],
          line: index,
        });
      };

      if (milestone && milestone !== currentMilestone) {
        currentMilestone = milestone;
        currentGoal = '';
        push('milestone', milestone, 'milestone');
      }
      if (goal && goal !== currentGoal) {
        currentGoal = goal;
        push('goal', goal, 'goal');
      }
      if (task) push('task', task, 'task');
    }

    // A project with a preamble but no rows is still a project you asked to
    // keep. Only a sheet that names nothing at all is skipped.
    if (rows.length === 0 && !preambleName(sheet, header.row)) {
      plan.skipped.push({ sheet: sheet.name, reason: 'header found but no data rows' });
      continue;
    }

    // Two sheets claiming one name means the template block was copied
    // unchanged. Fall back to the tab names and say so, rather than merging.
    const seen = namesSeen.get(projectName);
    if (seen !== undefined) {
      plan.review.push({
        sheet: sheet.name,
        message: `Another sheet also calls itself "${projectName}"; using the tab names instead.`,
      });
      const first = plan.sheets[seen];
      if (first) first.name = first.sheetName;
      projectName = sheet.name;
    } else {
      namesSeen.set(projectName, plan.sheets.length);
    }

    plan.sheets.push({ name: projectName, sheetName: sheet.name, rows });
  }

  return plan;
}

/** Load a workbook from bytes. exceljs is imported lazily; it is a large dependency. */
/**
 * A plain grid of strings, dressed up as the little of a workbook this module
 * actually uses.
 *
 * Google Sheets hands back `string[][]`; exceljs hands back an object graph.
 * Rather than write the header matching and the hierarchy tracking twice, the
 * grid borrows exceljs's shape for the length of one call. What a grid cannot
 * carry is font and fill — which is exactly why `readableGrids` writes "Done"
 * and "at risk" in words.
 */
export function gridsAsWorkbook(grids: { title: string; rows: string[][] }[]): Workbookish {
  const cellOf = (value: string): Cellish => ({ value });
  return {
    worksheets: grids.map((grid) => ({
      name: grid.title,
      rowCount: grid.rows.length,
      getRow: (index: number): Rowish => {
        const cells = grid.rows[index - 1] ?? [];
        return {
          number: index,
          cellCount: cells.length,
          getCell: (column: number) => cellOf(cells[column - 1] ?? ''),
          eachCell: (options, fn) => {
            cells.forEach((value, i) => {
              if (!options.includeEmpty && value === '') return;
              fn(cellOf(value), i + 1);
            });
          },
        };
      },
    })),
  };
}

/** The same reading `readWorkbook` does, from plain grids. */
export function readGrids(grids: { title: string; rows: string[][] }[]): ImportPlan {
  return readWorkbook(gridsAsWorkbook(grids));
}

export async function readWorkbookFile(data: ArrayBuffer | Buffer): Promise<ImportPlan> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.load(data as ArrayBuffer);
  return readWorkbook(workbook as unknown as Workbookish);
}

/** The vault out of a backup file, or null if the file has no backup in it. */
export async function readBackupFile(data: ArrayBuffer | Buffer): Promise<BackupRead | null> {
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  await workbook.xlsx.load(data as ArrayBuffer);
  return readBackupSheet(workbook as unknown as Workbookish);
}

export interface ImportSummary {
  projects: number;
  milestones: number;
  goals: number;
  tasks: number;
  done: number;
}

export function summarise(plan: ImportPlan): ImportSummary {
  const summary: ImportSummary = { projects: plan.sheets.length, milestones: 0, goals: 0, tasks: 0, done: 0 };
  for (const sheet of plan.sheets) {
    for (const row of sheet.rows) {
      if (row.kind === 'milestone') summary.milestones += 1;
      else if (row.kind === 'goal') summary.goals += 1;
      else summary.tasks += 1;
      if (row.done) summary.done += 1;
    }
  }
  return summary;
}
