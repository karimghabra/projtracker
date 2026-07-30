/**
 * The command-line client.
 *
 * A thin argv reader over the same command layer the app uses. Every command
 * takes `--json` so the output can be piped; without it, output is written for
 * a person reading a terminal.
 *
 * The vault is a directory of text files, so `pt` and the desktop app can point
 * at the same one and neither needs to know the other exists.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { App } from '../commands/app.ts';
import { toCommandError } from '../commands/errors.ts';
import { formatDayMonth, systemClock } from '../core/dates.ts';
import { formatOffset } from '../core/protocols.ts';
import { readWorkbookFile } from '../store/excel.ts';
import { exportWorkbook } from '../store/excelExport.ts';
import { NodeVault } from '../store/nodeVault.ts';

const HELP = `protracker — a lab project tracker

usage: pt [--vault DIR] [--json] <command> [args]

  seeing what to do
    today                     the day's list
    ready                     everything unblocked right now
    upcoming [--days N]       reminders and dates coming up
    progress                  which projects have gone quiet
    tree [ref]                the whole hierarchy
    show <ref>                one node in detail
    find <text>               search names, notes and the journal

  changing things
    add project <name>
    add <parent-ref> <name> [--seq N] [--experiment]
    rename <ref> <name>
    seq <ref> <n>             set the order number (a statement, not a guess)
    start|pause|done|drop|reopen <ref>
    plan <ref> <YYYY-MM-DD|none>
    wait <ref> <reason> [--until DATE]
    arrived <ref>
    rm <ref>

  dependencies
    link <from-ref> <to-ref>  make the second wait for the first
    unlink <dep-id>
    blockers <ref>

  the planner
    today add <ref>           pull something into today
    today new <text>          a standalone task
    today rm <ref>
    remind <text> --on DATE [--span N]
    note <text> [--node ref]
    journal [YYYY-MM]

  the lab
    scaffolds                 inventory summary
    scaffold type <name>      add a scaffold type
    scaffold add <type> <n>   record a fabricated batch
    protocols                 list crosslinking protocols
    crosslink <protocol> <batch-id...>
    runs                      live crosslinking runs
    step <run-id> <step-id>   tick a protocol step

  bringing a workbook across
    import <file.xlsx> [--preview] [--merge]
    export <file.xlsx>        write the board back out as a workbook

  the vault
    where                     where the files are
    undo | redo

  --vault DIR   defaults to $PROTRACKER_VAULT, else ~/.protracker/vault
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

function vaultPath(flags: Args['flags']): string {
  if (typeof flags['vault'] === 'string') return flags['vault'];
  return process.env['PROTRACKER_VAULT'] ?? join(homedir(), '.protracker', 'vault');
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = flags['json'] === true;

  if (positional.length === 0 || flags['help'] || positional[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const root = vaultPath(flags);
  const app = new App(new NodeVault(root), systemClock);
  const out = (value: unknown) => {
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  const ref = (token: string | undefined): string => {
    if (!token) throw new Error('Which one? Give a name, a ref or an id.');
    return app.resolve(token).id;
  };

  try {
    return await run(app, positional, flags, root, json, out, ref);
  } catch (error) {
    const failure = toCommandError(error);
    if (json) out({ ok: false, code: failure.code, message: failure.message, ...failure.details });
    else process.stderr.write(`${failure.message}\n`);
    return 1;
  }
}

async function run(
  app: App,
  positional: string[],
  flags: Args['flags'],
  root: string,
  json: boolean,
  out: (value: unknown) => void,
  ref: (token: string | undefined) => string,
): Promise<number> {
  const [command, ...rest] = positional;
  const say = (delta: { message: string }) => out(json ? delta : delta.message);

  switch (command) {
    // ------------------------------------------------------------- seeing
    case 'today': {
      if (rest[0] === 'add') return say(app.todayAdd(ref(rest[1]))), 0;
      if (rest[0] === 'new') return say(app.todayQuickAdd(rest.slice(1).join(' '))), 0;
      if (rest[0] === 'rm') return say(app.todayRemove(`node:${ref(rest[1])}`)), 0;

      const list = app.todayList();
      if (json) return out(list), 0;
      if (list.items.length === 0) return out('Nothing on today.'), 0;
      for (const item of list.items) {
        const box = item.done ? '[x]' : '[ ]';
        const badge =
          item.source === 'rolled-over'
            ? ` (carried ${item.ageDays}d)`
            : item.group
              ? ` — ${item.group.label}`
              : '';
        out(`${box} ${item.title}${badge}`);
      }
      out(`\n${list.doneCount}/${list.items.length} done`);
      return 0;
    }

    case 'ready': {
      const rows = app.ready();
      if (json) return out(rows), 0;
      if (rows.length === 0) return out('Nothing is unblocked right now.'), 0;
      for (const row of rows) out(`${row.id.padEnd(6)} ${row.name}  ${dim(row.path)}`);
      return 0;
    }

    case 'upcoming': {
      const days = Number(flags['days'] ?? 60);
      const data = app.upcoming(days);
      if (json) return out(data), 0;
      for (const late of data.late) out(`overdue  ${late.plannedFor}  ${late.name}`);
      for (const planned of data.planned) out(`planned  ${planned.plannedFor}  ${planned.name}`);
      for (const reminder of data.reminders) out(`remind   ${reminder.date}  ${reminder.title}`);
      if (!data.late.length && !data.planned.length && !data.reminders.length) out('Nothing coming up.');
      return 0;
    }

    case 'progress': {
      const rows = app.progress();
      if (json) return out(rows), 0;
      for (const row of rows) {
        const quiet = row.daysQuiet === null ? 'never touched' : `${row.daysQuiet}d quiet`;
        out(`${row.state.padEnd(9)} ${String(row.done).padStart(3)}/${String(row.total).padEnd(3)} ${row.name}  ${dim(quiet)}`);
      }
      return 0;
    }

    case 'tree': {
      const rootId = rest[0] ? ref(rest[0]) : null;
      const nodes = app.tree(rootId);
      if (json) return out(nodes), 0;
      const walk = (list: typeof nodes) => {
        for (const node of list) {
          const mark = node.derived === 'done' ? 'x' : node.derived === 'blocked' ? '-' : ' ';
          out(`${'  '.repeat(node.depth)}[${mark}] ${node.seq}. ${node.name}  ${dim(node.derived)}`);
          walk(node.children);
        }
      };
      walk(nodes);
      return 0;
    }

    case 'show': {
      const view = app.node(ref(rest[0]));
      if (json) return out(view), 0;
      out(`${view.name}   ${dim(view.ref)}`);
      out(`  ${view.kind} · ${view.derived}${view.health !== 'not_begun' ? ` · ${view.health}` : ''}`);
      if (view.plannedFor) out(`  planned for ${view.plannedFor}`);
      if (view.waitingOn) out(`  waiting on: ${view.waitingOn.reason}`);
      if (view.blockers.length) out(`  after: ${view.blockers.map((b) => b.name).join(', ')}`);
      if (view.progress) out(`  ${view.progress.done}/${view.progress.total} done`);
      if (view.experiment) {
        out(`  ${view.experiment.summary}`);
        for (const stage of view.experiment.stages) {
          out(`    [${stage.done ? 'x' : ' '}] ${stage.date}  ${stage.label}`);
        }
      }
      if (view.notes) out(`\n${view.notes}`);
      return 0;
    }

    case 'find': {
      const hits = app.search(rest.join(' '));
      if (json) return out(hits), 0;
      for (const hit of hits) out(`${hit.kind.padEnd(5)} ${hit.title}  ${dim(hit.context)}`);
      if (!hits.length) out('Nothing matches.');
      return 0;
    }

    case 'blockers': {
      const view = app.node(ref(rest[0]));
      if (json) return out(view.blockers), 0;
      if (!view.blockers.length) return out('Nothing is blocking it.'), 0;
      for (const blocker of view.blockers) {
        const why = blocker.via === 'dep' ? 'linked' : blocker.seqSource === 'assumed' ? 'assumed order' : 'your order';
        out(`${blocker.name}  ${dim(why)}${blocker.inherited ? dim(' (inherited)') : ''}`);
      }
      return 0;
    }

    // ------------------------------------------------------------ editing
    case 'add': {
      if (rest[0] === 'project') {
        return say(app.addProject(rest.slice(1).join(' '))), 0;
      }
      const parent = ref(rest[0]);
      const name = rest.slice(1).join(' ');
      const seq = flags['seq'] !== undefined ? Number(flags['seq']) : undefined;
      return say(app.addNode(parent, name, {
        seq,
        kind: flags['experiment'] === true ? 'experiment' : undefined,
      })), 0;
    }

    case 'rename':
      return say(app.updateNode(ref(rest[0]), { name: rest.slice(1).join(' ') })), 0;

    case 'seq':
      return say(app.setSeq(ref(rest[0]), Number(rest[1]))), 0;

    case 'start':
      return say(app.start(ref(rest[0]))), 0;
    case 'pause':
      return say(app.pause(ref(rest[0]))), 0;
    case 'done':
      return say(app.complete(ref(rest[0]))), 0;
    case 'drop':
      return say(app.drop(ref(rest[0]))), 0;
    case 'reopen':
      return say(app.reopen(ref(rest[0]))), 0;
    case 'rm':
      return say(app.deleteNode(ref(rest[0]))), 0;

    case 'plan': {
      const date = rest[1] === 'none' ? null : rest[1] ?? null;
      return say(app.planFor(ref(rest[0]), date)), 0;
    }

    case 'wait': {
      const until = typeof flags['until'] === 'string' ? flags['until'] : undefined;
      return say(app.wait(ref(rest[0]), rest.slice(1).join(' '), until)), 0;
    }

    case 'arrived':
      return say(app.arrived(ref(rest[0]))), 0;

    case 'link':
      return say(app.addDep(ref(rest[0]), ref(rest[1]))), 0;
    case 'unlink':
      return say(app.removeDep(rest[0]!)), 0;

    case 'remind': {
      const on = typeof flags['on'] === 'string' ? flags['on'] : undefined;
      if (!on) throw new Error('When? Pass --on YYYY-MM-DD.');
      const span = flags['span'] !== undefined ? Number(flags['span']) : undefined;
      return say(app.addReminder(rest.join(' '), on, { spanDays: span })), 0;
    }

    case 'note': {
      const node = typeof flags['node'] === 'string' ? ref(flags['node']) : undefined;
      return say(app.capture(rest.join(' '), node)), 0;
    }

    case 'journal': {
      const notes = app.journal(rest[0]);
      if (json) return out(notes), 0;
      for (const note of notes) out(`${note.at}  ${note.text}${note.nodeName ? dim(` · ${note.nodeName}`) : ''}`);
      if (!notes.length) out('No notes.');
      return 0;
    }

    // ---------------------------------------------------------------- lab
    case 'scaffolds': {
      const inventory = app.inventory();
      if (json) return out(inventory), 0;
      out('types');
      for (const type of inventory.types) out(`  ${type.id.padEnd(22)} ${String(type.total).padStart(4)}  ${type.name}`);
      out('\nbatches');
      for (const batch of inventory.batches) {
        out(`  ${batch.id.padEnd(6)} ${String(batch.count).padStart(4)} × ${batch.typeName.padEnd(22)} ${batch.state}  ${dim(formatDayMonth(batch.fabricatedOn, app.today))}`);
      }
      return 0;
    }

    case 'scaffold': {
      if (rest[0] === 'type') return say(app.addScaffoldType(rest.slice(1).join(' '))), 0;
      if (rest[0] === 'add') return say(app.addBatch(rest[1]!, Number(rest[2]))), 0;
      throw new Error('Use "scaffold type <name>" or "scaffold add <type> <count>".');
    }

    case 'protocols': {
      const inventory = app.inventory();
      if (json) return out(inventory.protocols), 0;
      for (const protocol of inventory.protocols) {
        out(`${protocol.id.padEnd(12)} ${protocol.name}  ${dim(`${protocol.steps} steps over ${formatOffset(protocol.hours).replace('+', '')}`)}`);
      }
      return 0;
    }

    case 'crosslink':
      return say(app.startRun(rest[0]!, rest.slice(1))), 0;

    case 'runs': {
      const inventory = app.inventory();
      if (json) return out(inventory.runs), 0;
      for (const item of inventory.runs) {
        out(`${item.id}  ${item.protocolName}  ${item.done}/${item.total}  ${item.batchLabels.join(', ')}`);
        for (const step of item.steps) {
          out(`  [${step.done ? 'x' : ' '}] ${step.id.padEnd(4)} ${step.at}  ${step.name}${step.overdue ? '  (due)' : ''}`);
        }
      }
      if (!inventory.runs.length) out('No runs.');
      return 0;
    }

    case 'step':
      return say(app.tickRunStep(rest[0]!, rest[1]!, flags['undo'] !== true)), 0;

    // ------------------------------------------------------------- import
    case 'import': {
      const file = rest[0];
      if (!file) throw new Error('Which workbook? pt import tracker.xlsx');

      const plan = await readWorkbookFile(readFileSync(file));
      const preview = app.importPreview(plan);

      if (flags['preview']) {
        if (json) return out(preview), 0;
        for (const sheet of preview.sheets) {
          const note = sheet.existingId
            ? ' (a project of this name already exists — pass --merge to add to it)'
            : '';
          out(`create  ${sheet.projectName}  ${dim(`${sheet.milestones}m ${sheet.goals}g ${sheet.tasks}t, ${sheet.done} done`)}${note}`);
        }
        for (const skip of preview.skipped) out(`skip    ${skip.sheet}  ${dim(skip.reason)}`);
        for (const item of preview.review) {
          out(`review  ${item.sheet}${item.line ? `:${item.line}` : ''}  ${item.message}`);
        }
        if (!preview.sheets.length) out('Nothing importable in that file.');
        return 0;
      }

      const decisions: Record<string, 'create' | 'merge'> = {};
      if (flags['merge']) for (const sheet of plan.sheets) decisions[sheet.sheetName] = 'merge';

      const delta = app.applyImport(plan, decisions);
      if (json) return out({ ...delta, review: preview.review }), 0;
      out(delta.message);
      for (const item of preview.review) {
        out(`review  ${item.sheet}${item.line ? `:${item.line}` : ''}  ${item.message}`);
      }
      return 0;
    }

    case 'export': {
      const file = rest[0];
      if (!file) throw new Error('Where to? pt export board.xlsx');
      const bytes = await exportWorkbook(app.state);
      writeFileSync(file, bytes);
      const delta = { ok: true as const, message: `Wrote ${bytes.length} bytes to ${file}.` };
      return say(delta), 0;
    }

    // -------------------------------------------------------------- vault
    case 'where':
      return out(json ? { vault: root } : root), 0;

    case 'undo':
      return say(app.undo()), 0;
    case 'redo':
      return say(app.redo()), 0;

    default:
      throw new Error(`Unknown command "${command}". Run "pt help" for the list.`);
  }
}

/** Dim text, but only when a terminal is going to interpret it. */
function dim(text: string): string {
  return process.stdout.isTTY ? `[2m${text}[0m` : text;
}

process.exitCode = await main(process.argv.slice(2));
