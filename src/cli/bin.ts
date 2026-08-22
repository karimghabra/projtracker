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
import { hostname } from 'node:os';
import { App } from '../commands/app.ts';
import { deviceTag } from '../commands/ids.ts';
import type { TreeNode } from '../commands/views.ts';
import { notFound, toCommandError } from '../commands/errors.ts';
import { formatDayMonth, systemClock } from '../core/dates.ts';
import type { Protocol } from '../core/model.ts';
import { formatOffset } from '../core/protocols.ts';
import { describeQuantity } from '../core/inventory.ts';
import { readBackupFile, readWorkbookFile } from '../store/excel.ts';
import { exportStatement, exportWorkbook } from '../store/excelExport.ts';
import { APP_VERSION } from '../core/version.ts';
import { NodeVault } from '../store/nodeVault.ts';
import { desktopVault, holdsVault } from '../desktop/vaultLocation.ts';
import { list, one, parseArgs, type Args } from './args.ts';

const HELP = `protracker — a lab project tracker

usage: pt [--vault DIR] [--json] <command> [args]

  seeing what to do
    today                     the day's list
    late                      what is overdue, and by how much
    ready                     everything unblocked right now
    doing                     what you started and have not finished
    cultures                  what is in the incubator, ending soonest first
    upcoming [--days N]       reminders and dates coming up
    progress                  which projects have gone quiet
    tree [ref]                the whole hierarchy
    show <ref | batch-id>     one node, or one batch, in detail
    find <text>               search names, notes and the journal
    help <command>            that command's usage alone

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
    deadline <ref> <YYYY-MM-DD|none>
                              the day it has to be finished by
    wait <ref> <reason> [--until DATE]
    arrived <ref>
    seed <ref> [--on DATE] [--cells NAME] [--count N] [--days N]
                              day zero of a culture; done collects it
    rm <ref>

  dependencies
    link <from-ref> <to-ref>  make the second wait for the first
    unlink <dep-id>
    blockers <ref>

  the planner
    today add <ref> [--on DATE]
                              pull something into today, or onto a day
    today new <text>          a standalone task
    today rm <ref>
    remind <text> --on DATE [--span N]
    note <text> [--node ref]
    journal [YYYY-MM]         notes alone
    log [YYYY-MM | DATE]      the manifest: everything recorded, by day
    statement <from> <to> [--xlsx FILE]
                              what was done, by project, between two days —
                              the record an invoice is written from

  the lab
    scaffolds                 inventory summary
    scaffold type <name>      add a scaffold type
    scaffold add <type> <n> [--label TEXT] [--on DATE]
                              record a fabricated batch; type by id or name
    protocols                 list crosslinking protocols and their steps
    protocol add <name> [--agent NAME] [--notes TEXT]
    protocol recipe <id> [--takes TYPE:AMOUNT] [--makes TYPE:AMOUNT]
                              what it spends and what it leaves behind;
                              TYPE by id or name.
                              Repeatable; no flags clears the recipe.
    protocol rm <id>
    protocol step add <protocol-id> <name> --at HOURS [--for HOURS]
    protocol step rm <protocol-id> <step-id>
    run <protocol> [batch-id...] [--at YYYY-MM-DDTHH:MM] [--task REF]
                   [--take BATCH:AMOUNT]
                              start a timed procedure. Batches are acted on and
                              handed back; --take is material it spends.
    crosslink ...             the same verb, named for the bath.
    lineage <batch-id>        what it was made from, and what it became.
    runs                      live crosslinking runs
    step <run-id> <step-id> [--undo]
                              tick a protocol step, or untick it

  bringing a workbook across
    import <file.xlsx> [--preview] [--merge]
    export <file.xlsx>        the readable workbook, for a person
    backup <file.xlsx>        the workbook plus the whole vault, for a restore
    restore <file.xlsx> --yes replace everything from a backup

  the vault
    where                     where the files are
    undo | redo

  --vault DIR   defaults to $PROTRACKER_VAULT, else the desktop app's vault on
                this machine, else ~/.protracker/vault; where says which.
  --new         start an empty vault at that path, alongside any command

  A <ref> is an id, a dotted path of slugs (project.milestone.goal.task), an
  exact name, or an exact slug. tree prints every node's ref, and so does add.
`;

/**
 * The help for one verb: its own lines out of the page, continuation lines
 * included. `pt help add` and `pt add --help` both land here, because every
 * cold reader of this CLI asked for one verb's usage and was handed the lot.
 */
function helpFor(verb: string): string {
  const lines = HELP.split('\n');
  const mine: string[] = [];
  let taking = false;
  for (const line of lines) {
    const trimmed = line.trim();
    const starts = trimmed === verb || trimmed.startsWith(`${verb} `) || trimmed.startsWith(`${verb}|`) || trimmed.includes(`|${verb}`);
    if (/^ {4}\S/.test(line)) taking = starts;
    if (taking && trimmed) mine.push(line);
  }
  return mine.length ? `${mine.join('\n')}\n` : `No such command "${verb}".\n\n${HELP}`;
}

/** `b12:20` — the thing and how much of it. */
function split(token: string, hint: string): [string, number] {
  const at = token.lastIndexOf(':');
  const quantity = at < 0 ? NaN : Number(token.slice(at + 1));
  if (at < 0 || !Number.isFinite(quantity)) throw new Error(hint);
  return [token.slice(0, at), quantity];
}

interface VaultChoice {
  path: string;
  /** How we arrived at it, which is what makes a warning worth printing. */
  source: 'flag' | 'env' | 'app' | 'default';
}

function vaultPath(flags: Args['flags']): VaultChoice {
  const given = one(flags['vault']);
  if (given !== undefined) return { path: given, source: 'flag' };
  const fromEnv = process.env['PROTRACKER_VAULT'];
  if (fromEnv) return { path: fromEnv, source: 'env' };
  // The desktop app's vault, when this machine has one: the CLI and the app
  // are two hands on one notebook, and the notebook is wherever the app keeps
  // it. Only then the CLI's own default.
  const shared = desktopVault();
  if (shared) return { path: shared, source: 'app' };
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
  process.stderr.write(`Note: ${choice.path} is not a vault yet, so this one is new — empty but for the two preset protocols.\n`);
  if (choice.source === 'default') {
    process.stderr.write('      Pass --vault DIR, or set PROTRACKER_VAULT, if you meant another.\n');
  }
}

async function main(argv: string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const json = flags['json'] === true;

  // `pt --new` alone used to print this help and create nothing, so the next
  // command failed with "no vault" — the flag works alongside a command, and
  // saying so beats demonstrating it.
  if (flags['new'] === true && positional.length === 0) {
    process.stderr.write('--new starts the vault when a command runs against it — give it one, e.g. pt --vault DIR --new add project "Name".\n');
    return 1;
  }

  if (positional.length === 0 || flags['help'] || positional[0] === 'help') {
    const verb = positional[0] === 'help' ? positional[1] : positional[0];
    process.stdout.write(verb ? helpFor(verb) : HELP);
    return 0;
  }

  const choice = vaultPath(flags);
  const root = choice.path;
  // Before NodeVault's constructor creates the directory and the answer stops
  // being knowable.
  const isNew = !holdsVault(root);
  /*
    A path given by hand that holds no vault is a typo far more often than it
    is a new vault. It used to be created in silence and every read then
    answered "nothing", successfully — so a mistyped --vault looked exactly
    like an empty week, and left a phantom vault on disk to find later.

    Refused, unless the intent is stated. The default path and $PROTRACKER_VAULT
    are still created on first use, because that is somebody's first run.
  */
  if (isNew && choice.source === 'flag' && flags['new'] !== true) {
    const message = `There is no vault at ${root}. Check the path, or pass --new to start one there.`;
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'not-found', message }, null, 2)}
`);
    else process.stderr.write(`${message}
`);
    return 1;
  }
  if (!json) warnAboutNewVault(choice);
  // The machine's own tag, so ids minted here cannot collide with ids minted
  // by the same vault open on another computer.
  const app = new App(new NodeVault(root), systemClock, deviceTag(hostname()));
  const out = (value: unknown) => {
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  };

  const ref = (token: string | undefined): string => {
    if (!token) throw new Error('Which one? Give a name, a ref or an id.');
    return app.resolve(token).id;
  };

  // A flag a verb never reads is a guess that went nowhere — and it used to go
  // nowhere silently, so a wrong `--deadline` looked like it had worked. Every
  // read is recorded; what was handed in and never read is named at the end.
  const read = new Set<string>();
  const watched = new Proxy(flags, {
    get(target, key) {
      if (typeof key === 'string') read.add(key);
      return target[key as string];
    },
  });
  try {
    const code = await run(app, positional, watched, root, json, out, ref, isNew);
    const ignored = Object.keys(flags).filter((k) => !read.has(k) && !['json', 'vault', 'new', 'help'].includes(k));
    if (ignored.length) process.stderr.write(`Note: ${ignored.map((k) => `--${k}`).join(', ')} ${ignored.length === 1 ? 'was' : 'were'} not used by this command.\n`);
    return code;
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
  /*
    Anything that mints an id says the id. Every verb here takes a ref, and a
    confirmation that keeps the ref to itself forces a `--json tree` round
    trip before the very next command — which is exactly what an agent driving
    this CLI was observed doing, three times per level.
  */
  const made = (delta: { id: string; message: string }) => {
    if (json) return out(delta);
    out(`${delta.id.padEnd(8)} ${delta.message}`);
  };
  // A scaffold type by its id or by the name it was given — the same rule in
  // every place a type is named, because "collagen sponge" working in one verb
  // and failing in the next reads as a bug.
  const typeIdOf = (token: string): string => {
    const type =
      app.state.scaffoldTypes.find((t) => t.id === token) ??
      app.state.scaffoldTypes.find((t) => t.name.toLowerCase() === token.toLowerCase());
    if (!type) throw notFound('scaffold type', token);
    return type.id;
  };

  switch (command) {
    // ------------------------------------------------------------- seeing
    case 'today': {
      if (rest[0] === 'add') return say(app.todayAdd(ref(rest[1]), one(flags['on']))), 0;
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
      for (const row of rows) {
        // A culture arrives as the act it is asking for, not as itself, and
        // the list has to say which — "Osteogenic culture" alone reads as a
        // task and is neither of the two things you can do to it.
        const name = row.action === 'seed' ? `Seed ${row.name}`
          : row.action === 'collect' ? `Collect ${row.name}`
          : row.name;
        out(`${row.id.padEnd(6)} ${name}  ${dim(row.path)}`);
      }
      return 0;
    }

    /**
     * What is in the incubator, which `ready` deliberately no longer says: a
     * running culture is not work you can pick up, and the pool is for work you
     * can. Same list as the dashboard's card, same order — ending soonest
     * first, because that is the one about to need hands.
     */
    case 'cultures': {
      const rows = app.experiments();
      if (json) return out(rows), 0;
      if (rows.length === 0) return out('Nothing is in the incubator.'), 0;
      for (const row of rows) {
        out(`${row.id.padEnd(6)} ${row.name}  ${dim(row.experiment!.summary)}`);
        if (row.parentPath) out(`${' '.repeat(7)}${dim(row.parentPath)}`);
      }
      return 0;
    }

    case 'doing': {
      const rows = app.inProgress();
      if (json) return out(rows), 0;
      if (rows.length === 0) return out('Nothing is started right now.'), 0;
      for (const row of rows) {
        const since = row.startedAt ? formatDayMonth(row.startedAt.slice(0, 10), app.today) : '';
        out(`${row.id.padEnd(6)} ${row.name}  ${dim(since ? `since ${since}` : row.path)}`);
      }
      return 0;
    }

    case 'late': {
      const late = app.late();
      if (json) return out(late), 0;
      const total = late.reminders.length + late.tasks.length + late.deadlines.length;
      if (!total) return out('Nothing is late.'), 0;
      const over = (n: number) => `${n} day${n === 1 ? '' : 's'} over`;
      if (late.deadlines.length) {
        out('past their deadline');
        for (const d of late.deadlines) out(`  ${d.name}  ${dim(`${d.parentPath} · due ${d.due} · ${over(d.daysOver)}`)}`);
      }
      if (late.tasks.length) {
        out('carried from an earlier day');
        for (const t of late.tasks) out(`  ${t.name}  ${dim(`${t.parentPath} · since ${t.since} · ${over(t.daysOver)}`)}`);
      }
      if (late.reminders.length) {
        out('reminders still waiting');
        for (const r of late.reminders) out(`  ${r.title}  ${dim(`since ${r.since} · ${over(r.daysOver)}`)}`);
      }
      return 0;
    }

    case 'upcoming': {
      const days = Number(one(flags['days']) ?? 60);
      const data = app.upcoming(days);
      if (json) return out(data), 0;
      // What is late is on `today`, saying how late it is, rather than here.
      for (const planned of data.planned) out(`planned  ${planned.plannedFor}  ${planned.name}`);
      for (const reminder of data.reminders) out(`remind   ${reminder.date}  ${reminder.title}`);
      if (!data.planned.length && !data.reminders.length) out('Nothing coming up.');
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
          out(`${'  '.repeat(node.depth)}[${mark}] ${node.seq}. ${node.name}  ${dim(node.ref)}  ${dim(node.derived)}`);
          walk(node.children);
        }
      };
      walk(nodes);
      return 0;
    }

    case 'show': {
      // A batch id answers here too: `show` is "tell me about this", and an
      // inventory batch is a thing a person holds in their hand.
      if (rest[0] && !app.find(rest[0])) {
        const batch = app.inventory().batches.find((b) => b.id === rest[0]);
        if (batch) {
          const lineage = app.lineage(batch.id);
          if (json) return out({ ...batch, lineage }), 0;
          out(`${batch.typeName}${batch.label ? ` — ${batch.label}` : ''}   ${dim(batch.id)}`);
          out(`  ${batch.count} in stock · ${batch.state} · fabricated ${batch.fabricatedOn}${batch.location ? ` · kept ${batch.location}` : ''}`);
          if (batch.runName) out(`  in a ${batch.runName} run`);
          if (batch.usedByName) out(`  seeded into ${batch.usedByName}`);
          for (const step of batch.history) out(`  ${step.at}  ${step.state}${step.note ? `  ${dim(step.note)}` : ''}`);
          if (lineage?.madeFrom.length) out(`  made from: ${lineage.madeFrom.map((s) => `${s.batchId} ${s.name}`).join(', ')}`);
          if (lineage?.wentInto.length) out(`  went into: ${lineage.wentInto.map((s) => `${s.batchId} ${s.name}`).join(', ')}`);
          return 0;
        }
      }
      const view = app.node(ref(rest[0]));
      if (json) return out(view), 0;
      out(`${view.name}   ${dim(view.ref)}`);
      out(`  ${view.kind} · ${view.derived}${view.health !== 'not_begun' ? ` · ${view.health}` : ''}`);
      if (view.doneLabel) out(`  completed ${view.doneLabel}`);
      if (view.plannedFor) out(`  planned for ${view.plannedFor}`);
      if (view.waitingOn) out(`  waiting on: ${view.waitingOn.reason}${view.waitingOn.until ? ` (until ${view.waitingOn.until})` : ''}`);
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
        return made(app.addProject(rest.slice(1).join(' '))), 0;
      }
      const parent = ref(rest[0]);
      const name = rest.slice(1).join(' ');
      const seqFlag = one(flags['seq']);
      const seq = seqFlag !== undefined ? Number(seqFlag) : undefined;
      return made(app.addNode(parent, name, {
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
      const when = one(flags['in']);
      const underFlag = one(flags['under']);
      const under = underFlag !== undefined ? ref(underFlag) : null;
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

    case 'seed': {
      // Day zero of a culture, from the bench: what went in, when, and how
      // long it runs. Anything not said keeps what the experiment already had.
      const id = ref(rest[0]);
      const current = app.node(id).experiment?.def;
      const count = one(flags['count']);
      const days = one(flags['days']);
      const cells = one(flags['cells']);
      return say(app.seedCulture(id, {
        ...(current ?? { sampleCount: 0, durationDays: 21, mediaPhases: [], stagesDone: [] }),
        seedingDate: one(flags['on']) ?? app.today,
        ...(count !== undefined ? { sampleCount: Number(count) } : {}),
        ...(days !== undefined ? { durationDays: Number(days) } : {}),
        ...(cells !== undefined ? { cellLine: cells } : {}),
      })), 0;
    }

    case 'deadline': {
      const when = rest[1];
      if (!when) throw new Error('When? pt deadline <ref> YYYY-MM-DD, or none to clear it.');
      if (when !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(when)) {
        throw new Error(`Cannot read "${when}" as a day. Use YYYY-MM-DD, or none to clear it.`);
      }
      return say(app.updateNode(ref(rest[0]), { deadline: when === 'none' ? null : when })), 0;
    }

    case 'wait': {
      const until = one(flags['until']);
      return say(app.wait(ref(rest[0]), rest.slice(1).join(' '), until)), 0;
    }

    case 'arrived':
      return say(app.arrived(ref(rest[0]))), 0;

    case 'link':
      return say(app.addDep(ref(rest[0]), ref(rest[1]))), 0;
    case 'unlink':
      return say(app.removeDep(rest[0]!)), 0;

    case 'remind': {
      const on = one(flags['on']);
      if (!on) throw new Error('When? Pass --on YYYY-MM-DD.');
      const spanFlag = one(flags['span']);
      const span = spanFlag !== undefined ? Number(spanFlag) : undefined;
      return made(app.addReminder(rest.join(' '), on, { spanDays: span })), 0;
    }

    case 'note': {
      const nodeFlag = one(flags['node']);
      const node = nodeFlag !== undefined ? ref(nodeFlag) : undefined;
      return made(app.capture(rest.join(' '), node)), 0;
    }

    case 'journal': {
      const notes = app.journal(rest[0]);
      if (json) return out(notes), 0;
      for (const note of notes) out(`${note.at}  ${note.text}${note.nodeName ? dim(` · ${note.nodeName}`) : ''}`);
      if (!notes.length) out('No notes.');
      return 0;
    }

    case 'log': {
      // The manifest: everything recorded — notes, completions, fabrications,
      // batch movements, runs and their steps — read by the day.
      const when = rest[0];
      if (when && !/^\d{4}-\d{2}(-\d{2})?$/.test(when)) {
        throw new Error(`Cannot read "${when}" as a month or a day. Try 2026-08 or 2026-08-20.`);
      }
      const month = when ? when.slice(0, 7) : app.today.slice(0, 7);
      const entries = app
        .log(month)
        .filter((e) => (when && when.length === 10 ? e.at.startsWith(when) : true));
      if (json) return out(entries), 0;
      if (!entries.length) return out('Nothing recorded.'), 0;
      let day = '';
      for (const entry of entries) {
        if (entry.at.slice(0, 10) !== day) {
          day = entry.at.slice(0, 10);
          out(`${day === app.today ? `${day} (today)` : day}`);
        }
        const period = entry.period ? `  (${entry.period})` : '';
        const where = entry.parentPath ? dim(`  · ${entry.parentPath}`) : '';
        out(`  ${entry.at.slice(11, 16)}  ${entry.text}${period}${where}`);
      }
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
      if (rest[0] === 'type') return made(app.addScaffoldType(rest.slice(1).join(' '))), 0;
      if (rest[0] === 'add') {
        // The id is the canonical handle, but the name the user just typed to
        // create the type has to work too — "collagen sponge" failing right
        // after `scaffold type "Collagen sponge"` succeeded reads as a bug.
        const typeId = typeIdOf(rest[1] ?? '');
        return made(app.addBatch(typeId, Number(rest[2]), { label: one(flags['label']), fabricatedOn: one(flags['on']) })), 0;
      }
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
        const agent = one(flags['agent']) ?? '';
        const notes = one(flags['notes']);
        const name = rest.slice(1).join(' ');
        // Every vault ships with preset protocols, which nothing else says out
        // loud — so "set up EDC/NHS crosslinking" naturally starts with `add`
        // and silently mints an empty twin of a fully populated preset.
        const twin = app.state.protocols.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
        if (twin && !json) {
          process.stderr.write(`Note: a protocol named "${twin.name}" already exists (${twin.id}) — editing that one may be what you meant.\n`);
        }
        const added = app.addProtocol(name, agent, [], notes);
        if (json) return out(added), 0;
        return out(`${added.id.padEnd(12)} ${added.message}`), 0;
      }
      if (rest[0] === 'rm') return say(app.deleteProtocol(rest[1] ?? '')), 0;

      /*
        The recipe, set as one statement rather than a field at a time: what it
        takes off the shelf and what it puts back. Both are repeatable and both
        are replaced wholesale, so `protocol recipe p1` with no flags clears it.
      */
      if (rest[0] === 'recipe') {
        const protocol = protocolOf(app, rest[1]);
        const parse = (name: string) =>
          list(flags[name]).map((token) => {
            const [type, quantity] = split(token, `Use --${name} TYPE:AMOUNT.`);
            return { typeId: typeIdOf(type), quantity };
          });
        return say(app.setProtocolIO(protocol.id, { consumes: parse('takes'), produces: parse('makes') })), 0;
      }

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

    // `crosslink` is what this was called when crosslinking was all it did.
    // `run` is the same verb without the assumption, and both are kept: one
    // reads better for a bath, the other for a dialysis.
    case 'crosslink':
    case 'run': {
      // A run typed up after the fact started when it started: every step's
      // time is counted from here, so the default of "now" would date them all
      // to the moment of typing.
      const at = one(flags['at']);
      const taskFlag = one(flags['task']);
      const task = taskFlag !== undefined ? ref(taskFlag) : undefined;
      // --take b12:20 — a batch and how much of it to spend. Repeatable.
      const take = list(flags['take']).map((token) => {
        const [batchId, quantity] = split(token, 'Use --take BATCH:AMOUNT.');
        return { batchId, quantity };
      });
      // The id is what `step <run-id> <step-id>` asks for next; a start that
      // keeps it to itself forces a `runs` round trip before the first tick.
      return made(app.startRun(rest[0]!, rest.slice(1), at, task, take)), 0;
    }

    case 'lineage': {
      const batchId = rest[0];
      if (!batchId) throw new Error('Which batch? Give a batch id.');
      // A mistyped id and a batch with no history would otherwise read the
      // same: "nothing either side" is only an answer about a batch that exists.
      const lineage = app.lineage(batchId);
      if (!lineage) throw notFound('batch', batchId);
      if (json) return out(lineage), 0;
      const label = (step: { name: string; label?: string }) => `${step.name}${step.label ? ` (${step.label})` : ''}`;
      if (!lineage.madeFrom.length && !lineage.wentInto.length) {
        return out(dim('Nothing recorded either side of it.')), 0;
      }
      for (const step of lineage.madeFrom) {
        out(`${'  '.repeat(step.depth - 1)}↑ ${step.batchId.padEnd(8)} ${label(step)}  ${dim(`${step.quantity} into ${step.runName} (${step.runId})`)}`);
      }
      for (const step of lineage.wentInto) {
        out(`${'  '.repeat(step.depth - 1)}↓ ${step.batchId.padEnd(8)} ${label(step)}  ${dim(`via ${step.runName} (${step.runId})`)}`);
      }
      return 0;
    }

    case 'runs': {
      const inventory = app.inventory();
      if (json) return out(inventory.runs), 0;
      for (const item of inventory.runs) {
        const spending = item.spent.length
          ? dim(`  spending ${item.spent.map((s) => `${describeQuantity(s.quantity, s.name, s.unit)}${s.label ? ` (${s.label})` : ''}`).join(', ')}`)
          : '';
        out(`${item.id}  ${item.protocolName}  ${item.done}/${item.total}  ${item.batchLabels.join(', ')}${spending}`);
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

    case 'statement': {
      const [from, to] = [rest[0], rest[1]];
      if (!from || !to) throw new Error('Between which days? pt statement 2026-08-01 2026-08-31 [--xlsx statement.xlsx]');
      const statement = app.statement(from, to);
      const file = one(flags['xlsx']);
      if (file) writeFileSync(file, await exportStatement(statement));
      if (json) return out(statement), 0;
      out(`${from} → ${to}: ${statement.days} day${statement.days === 1 ? '' : 's'} with recorded work, ${statement.projects.length} project${statement.projects.length === 1 ? '' : 's'}`);
      for (const project of statement.projects) {
        out(`\n${project.name}  ${dim(`${project.days} day(s) · ${project.completed} completed · ${project.notes} journal · ${project.runs} runs · ${project.batches} batches`)}`);
        let day = '';
        for (const entry of project.entries) {
          if (entry.at.slice(0, 10) !== day) {
            day = entry.at.slice(0, 10);
            out(`  ${day}`);
          }
          out(`    ${entry.at.slice(11, 16)}  ${entry.text}${entry.period ? ` (${entry.period})` : ''}`);
        }
      }
      if (file) out(`\nWrote ${file}.`);
      return 0;
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
function hours(value: string | boolean | string[] | undefined, question: string): number {
  const given = one(value);
  const n = Number(given);
  if (given === undefined || !Number.isFinite(n)) throw new Error(question);
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
