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
import type { TreeNode } from '../commands/views.ts';
import { notFound, toCommandError } from '../commands/errors.ts';
import { formatDayMonth, systemClock } from '../core/dates.ts';
import type { Protocol } from '../core/model.ts';
import { formatOffset } from '../core/protocols.ts';
import { readBackupFile, readWorkbookFile } from '../store/excel.ts';
import { exportWorkbook } from '../store/excelExport.ts';
import { APP_VERSION } from '../core/version.ts';
import { NodeVault } from '../store/nodeVault.ts';
import { holdsVault } from '../desktop/vaultLocation.ts';

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
    done <ref> [--in PERIOD]  back-fill: --in Q3, --in "Aug 2026", --in 2025
    done <ref>... [--under REF] [--undated] --in PERIOD
                              several at once, as one undo step. --undated
                              picks only what was completed with no period,
                              which is what a back-fill is correcting.
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
    protocols                 list crosslinking protocols and their steps
    protocol add <name> [--agent NAME] [--notes TEXT]
    protocol rm <id>
    protocol step add <protocol-id> <name> --at HOURS [--for HOURS]
    protocol step rm <protocol-id> <step-id>
    crosslink <protocol> <batch-id...> [--at YYYY-MM-DDTHH:MM]
    runs                      live crosslinking runs
    step <run-id> <step-id>   tick a protocol step

  bringing a workbook across
    import <file.xlsx> [--preview] [--merge]
    export <file.xlsx>        the readable workbook, for a person
    backup <file.xlsx>        the workbook plus the whole vault, for a restore
    restore <file.xlsx> --yes replace everything from a backup

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

interface VaultChoice {
  path: string;
  /** How we arrived at it, which is what makes a warning worth printing. */
  source: 'flag' | 'env' | 'default';
}

function vaultPath(flags: Args['flags']): VaultChoice {
  if (typeof flags['vault'] === 'string') return { path: flags['vault'], source: 'flag' };
  const fromEnv = process.env['PROTRACKER_VAULT'];
  if (fromEnv) return { path: fromEnv, source: 'env' };
  return { path: join(homedir(), '.protracker', 'vault'), source: 'default' };
}

/**
 * Say so when we are about to work in a folder that is not a vault yet.
 *
 * NodeVault creates its directory on demand, which is right for `pt add` in a
 * fresh install and dangerous everywhere else: with no --vault and no
 * PROTRACKER_VAULT, a mistyped or unset environment silently produces an empty
 * vault, and every command then succeeds against nothing at all.
 */
function warnAboutNewVault(choice: VaultChoice): void {
  if (holdsVault(choice.path)) return;
  process.stderr.write(`Note: ${choice.path} is not a vault yet, so this one is new and empty.\n`);
  if (choice.source === 'default') {
    process.stderr.write('      Pass --vault DIR, or set PROTRACKER_VAULT, if you meant another.\n');
  }
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = flags['json'] === true;

  if (positional.length === 0 || flags['help'] || positional[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  const choice = vaultPath(flags);
  const root = choice.path;
  // Before NodeVault's constructor creates the directory and the answer stops
  // being knowable.
  const isNew = !holdsVault(root);
  if (!json) warnAboutNewVault(choice);
  const app = new App(new NodeVault(root), systemClock);
  const out = (value: unknown) => {
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  const ref = (token: string | undefined): string => {
    if (!token) throw new Error('Which one? Give a name, a ref or an id.');
    return app.resolve(token).id;
  };

  try {
    return await run(app, positional, flags, root, json, out, ref, isNew);
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
  isNew: boolean,
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
      if (view.doneLabel) out(`  completed ${view.doneLabel}`);
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
      if (view.troubleshooting) out(`\nTroubleshooting\n${view.troubleshooting}`);
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
    case 'done': {
      const when = typeof flags['in'] === 'string' ? flags['in'] : undefined;
      const under = typeof flags['under'] === 'string' ? ref(flags['under']) : null;
      const undated = flags['undated'] === true;

      const targets = selectForCompletion(app, rest, under, undated);
      if (!targets.length) {
        throw new Error(
          undated
            ? 'Nothing there is completed without a period. Nothing to re-date.'
            : 'Which one? Give a name, a ref or an id, or --under a parent.',
        );
      }

      // One target keeps the single-item verb, which reports what the
      // completion freed and refuses a second completion of the same thing.
      // Several go through completeMany, which is one undo step however many
      // there are — the whole reason a backfill is worth doing at all.
      if (targets.length === 1 && !undated) return say(app.complete(targets[0]!, when)), 0;
      return say(app.completeMany(targets, when ?? app.today)), 0;
    }
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
      for (const type of inventory.types) out(`  ${type.id.padEnd(22)} ${String(type.inStock).padStart(4)}  ${type.name}`);
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
        // "0 steps over start" is what a protocol reads as between being made
        // and being filled in, which is now an ordinary place to be.
        const summary = protocol.steps
          ? `${protocol.steps} step${protocol.steps === 1 ? '' : 's'} over ${formatOffset(protocol.hours).replace('+', '')}`
          : 'no steps yet';
        out(`${protocol.id.padEnd(12)} ${protocol.name}  ${dim(summary)}`);
        // The step ids are printed because "protocol step rm" asks for one, and
        // an id nothing shows is an id nobody can type.
        for (const step of protocolOf(app, protocol.id).steps) {
          const span = step.durationHours ? ` for ${formatOffset(step.durationHours).replace('+', '')}` : '';
          out(`  ${step.id.padEnd(4)} ${formatOffset(step.offsetHours).padEnd(10)} ${step.name}${dim(span)}`);
        }
      }
      return 0;
    }

    case 'protocol': {
      if (rest[0] === 'add') {
        const agent = typeof flags['agent'] === 'string' ? flags['agent'] : '';
        const notes = typeof flags['notes'] === 'string' ? flags['notes'] : undefined;
        const made = app.addProtocol(rest.slice(1).join(' '), agent, [], notes);
        if (json) return out(made), 0;
        return out(`${made.id.padEnd(12)} ${made.message}`), 0;
      }
      if (rest[0] === 'rm') return say(app.deleteProtocol(rest[1] ?? '')), 0;

      // Both step verbs hand the whole list back, ids and all. An id says "this
      // is the step you gave me"; sending one without would re-key it, and a
      // live run records what it has done against those ids.
      if (rest[0] === 'step' && rest[1] === 'add') {
        const protocol = protocolOf(app, rest[2]);
        const at = hours(flags['at'], 'When? Pass --at HOURS after the run starts.');
        const span = flags['for'] === undefined ? undefined : hours(flags['for'], 'How long? Pass --for HOURS.');
        return say(app.updateProtocol(protocol.id, {
          steps: [...protocol.steps, { name: rest.slice(3).join(' '), offsetHours: at, durationHours: span }],
        })), 0;
      }
      if (rest[0] === 'step' && rest[1] === 'rm') {
        const protocol = protocolOf(app, rest[2]);
        const steps = protocol.steps.filter((s) => s.id !== rest[3]);
        if (steps.length === protocol.steps.length) throw notFound(`step of "${protocol.name}"`, rest[3] ?? '');
        return say(app.updateProtocol(protocol.id, { steps })), 0;
      }
      throw new Error('Use "protocol add <name>", "protocol rm <id>" or "protocol step add|rm".');
    }

    case 'crosslink': {
      // A run typed up after the fact started when it started: every step's
      // time is counted from here, so the default of "now" would date them all
      // to the moment of typing.
      const at = typeof flags['at'] === 'string' ? flags['at'] : undefined;
      return say(app.startRun(rest[0]!, rest.slice(1), at)), 0;
    }

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
      const bytes = await exportWorkbook(app.state, app.today);
      writeFileSync(file, bytes);
      const delta = { ok: true as const, message: `Wrote ${bytes.length} bytes to ${file}.` };
      return say(delta), 0;
    }

    case 'backup': {
      const file = rest[0];
      if (!file) throw new Error('Where to? pt backup "Protracker backup.xlsx"');
      // A backup of a vault that did not exist a moment ago is a file full of
      // nothing that reports success, and the next destructive step trusts it.
      // Refusing is the only safe answer: this is the one command where being
      // wrong about which vault you are in cannot be noticed later.
      if (isNew) {
        throw new Error(
          `${root} was empty, so there is nothing to back up. ` +
            'Pass --vault DIR, or set PROTRACKER_VAULT, to name the vault you meant.',
        );
      }
      // The same workbook `export` writes, plus the vault itself on a hidden
      // sheet. Scriptable on purpose: this is the form that belongs in a cron
      // job, and a backup nobody has to remember to take is the only kind that
      // reliably exists.
      const files = app.backupFiles();
      const bytes = await exportWorkbook(app.state, app.today, {
        files,
        meta: { generatedAt: app.now, version: APP_VERSION },
      });
      writeFileSync(file, bytes);
      return say({ message: `Backed up ${Object.keys(files).length} vault file(s) to ${file}.` }), 0;
    }

    case 'restore': {
      const file = rest[0];
      if (!file) throw new Error('Restore from what? pt restore "Protracker backup.xlsx"');
      const read = await readBackupFile(readFileSync(file));
      if (!read) {
        throw new Error(
          `${file} has no backup in it. An export is a report; use a file written by "pt backup".`,
        );
      }
      if (read.problems.length) {
        // Nothing is written. Naming what is wrong beats restoring most of it.
        for (const problem of read.problems) out(problem);
        throw new Error('That backup is damaged, so nothing was changed.');
      }
      if (flags['yes'] !== true) {
        out(`This replaces everything in ${root} with ${Object.keys(read.files).length} file(s)`);
        out(`from ${file}, backed up ${read.meta.generatedAt || 'at an unknown time'}.`);
        out('It cannot be undone. Add --yes to go ahead.');
        return 1;
      }
      return say(app.restoreBackup(read.files)), 0;
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

/**
 * The protocol a command names. Editing one step means handing the command
 * layer the others back untouched, so the client has to see them first.
 */
function protocolOf(app: App, token: string | undefined): Protocol {
  const found = app.state.protocols.find((p) => p.id === token);
  if (!found) throw notFound('protocol', token ?? '');
  return found;
}

/** A flag that has to be a number of hours, or the question it did not answer. */
function hours(value: string | boolean | undefined, question: string): number {
  const n = Number(value);
  if (typeof value !== 'string' || !Number.isFinite(n)) throw new Error(question);
  return n;
}

/**
 * What `done` should act on: the refs given, everything under a parent, or
 * both — narrowed to work already completed without a period when `--undated`
 * is passed.
 *
 * `--undated` is the selection a backfill actually wants. A completion carrying
 * a minute-precision stamp from the day it was typed in is not a record of when
 * the work happened, and "everything in that state" is tedious to name by hand.
 */
function selectForCompletion(
  app: App,
  tokens: string[],
  under: string | null,
  undated: boolean,
): string[] {
  const ids: string[] = tokens.map((token) => app.resolve(token).id);

  if (under) {
    const walk = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (!node.children.length) ids.push(node.id);
        walk(node.children);
      }
    };
    walk(app.tree(under));
  }

  const unique = [...new Set(ids)];
  if (!undated) return unique;

  return unique.filter((id) => {
    const node = app.state.nodes[id];
    // Done, but with no period recorded — so `doneAt` is when it was typed in.
    return node?.status === 'done' && node.donePrecision === undefined;
  });
}

/** Dim text, but only when a terminal is going to interpret it. */
function dim(text: string): string {
  return process.stdout.isTTY ? `[2m${text}[0m` : text;
}

process.exitCode = await main(process.argv.slice(2));
