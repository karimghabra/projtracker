/**
 * Excel export.
 *
 * The other half of the interchange path: a workbook in the same layout the
 * importer reads, so a board can go out to a collaborator, a supervisor or a
 * backup and come back without losing its shape.
 *
 * Round-tripping is the actual requirement. Whatever this writes, `readWorkbook`
 * must read back into the same hierarchy, the same order, and the same
 * completion — which is why strikethrough is written for done and fill colour
 * for health, matching how they are read.
 */

import type { ExperimentDef, Health, State } from '../core/model.ts';
import { childrenOf, isContainerKind } from '../core/model.ts';
import { rootProjects } from '../core/graph.ts';
import { buildIndex } from '../core/graph.ts';

const HEALTH_FILL: Record<Health, string | undefined> = {
  not_begun: undefined,
  on_track: 'FF63BE7B',
  at_risk: 'FFFFC000',
  off_track: 'FFFF6B6B',
};

export const EXPORT_HEADERS = [
  'Seq',
  'Milestone',
  'Goal',
  'Task',
  'Kind',
  'Status',
  'Health',
  'Planned',
  'Tags',
  'Culture',
  'Notes',
] as const;

interface Cellish {
  value: unknown;
  font?: unknown;
  fill?: unknown;
  alignment?: unknown;
}
interface Rowish {
  getCell(index: number): Cellish;
  font?: unknown;
}
interface Sheetish {
  addRow(values: unknown[]): Rowish;
  columns: unknown;
  views: unknown;
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

export function writeWorkbook(book: Bookish, state: State): void {
  const index = buildIndex(state);
  const taken = new Set<string>();

  for (const project of rootProjects(index)) {
    const sheet = book.addWorksheet(sheetName(project.name, taken));

    // A preamble the importer reads back, so a renamed tab does not rename the
    // project on the way home.
    const title = sheet.addRow(['Project name', project.name]);
    title.getCell(1).font = { bold: true };
    sheet.addRow([]);

    const header = sheet.addRow([...EXPORT_HEADERS]);
    for (let i = 1; i <= EXPORT_HEADERS.length; i++) {
      header.getCell(i).font = { bold: true };
      header.getCell(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } };
    }

    const write = (nodeId: string, milestone: string, goal: string) => {
      for (const child of childrenOf(state, nodeId)) {
        const isMilestone = child.kind === 'milestone';
        const isGoal = child.kind === 'goal';

        const row = sheet.addRow([
          child.seq,
          isMilestone ? child.name : '',
          isGoal ? child.name : '',
          isContainerKind(child.kind) ? '' : child.name,
          child.kind === 'experiment' ? 'experiment' : '',
          child.status === 'done' ? 'Done' : child.status === 'dropped' ? 'Dropped' : '',
          child.health === 'not_begun' ? '' : child.health.replace('_', ' '),
          child.plannedFor ?? '',
          child.tags.join(', '),
          child.experiment ? encodeCulture(child.experiment) : '',
          child.notes ?? '',
        ]);

        // The column this node's own name is in — that is where done and health
        // are marked, matching exactly where the importer looks for them.
        const own = isMilestone ? 2 : isGoal ? 3 : 4;
        if (child.status === 'done') row.getCell(own).font = { strike: true };
        const fill = HEALTH_FILL[child.health];
        if (fill) {
          row.getCell(own).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        }

        write(
          child.id,
          isMilestone ? child.name : milestone,
          isGoal ? child.name : goal,
        );
      }
    };

    write(project.id, '', '');

    sheet.columns = [
      { width: 6 },
      { width: 26 },
      { width: 26 },
      { width: 34 },
      { width: 11 },
      { width: 10 },
      { width: 12 },
      { width: 12 },
      { width: 18 },
      { width: 40 },
      { width: 44 },
    ];
    // Freeze the header so a long project stays navigable.
    sheet.views = [{ state: 'frozen', ySplit: 3 }];
  }
}

export async function exportWorkbook(state: State): Promise<Uint8Array> {
  const ExcelJS = await import('exceljs');
  const book = new ExcelJS.default.Workbook();
  book.creator = 'Protracker';
  book.created = new Date();
  writeWorkbook(book as unknown as Bookish, state);
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
