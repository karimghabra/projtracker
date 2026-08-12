# Protracker

A lab planner. It holds the shape of the work — projects, milestones, goals,
task sequences and cell culture experiments — the scaffold inventory that work
consumes, and the day-to-day surface that turns both into "what am I doing
today".

**[Download →](https://github.com/karimghabra/projtracker/releases/latest)**

| Platform | File |
|---|---|
| Windows | `Protracker-Setup-*.exe` |
| macOS | `Protracker-*-arm64.dmg` (Apple silicon) or `-x64.dmg` (Intel) |
| Linux | `Protracker-*.AppImage` or `.deb` |

No Python, no Rust, no compilers. Windows and macOS install per-user, so no
administrator is needed. The builds are unsigned, so Windows SmartScreen warns
on first run (More info → Run anyway) and macOS needs right-click → Open once.

---

## What it does

**Today** opens first: the day's list, a calendar, what is coming up, somewhere
to jot a thought, and how each project is going. Pull work in from the ready
pool, or just type what you need to do — a task need not belong to a project.
Anything unfinished rolls forward until you deal with it, and so does anything
dated that you missed.

**The calendar is where you plan**, not just where you look. Click any day to
open it: one field puts a task on that day, one button sets a reminder on it,
and whatever is already there can be ticked or taken off. Reminders can run
over several days — a span says "show me on these days" and expires; a one-day
reminder keeps rolling forward until it is dealt with.

**Projects** are a hierarchy: project → milestone → goal → tasks or an
experiment. Every level takes a sequence number, and those numbers *are* the
dependencies: task 2 waits for task 1, and two things given the same number can
run side by side. A guided wizard walks you through it the first time;
everything stays editable afterwards.

**The graph** draws that hierarchy and lets you link across it. Drag from one
card onto another to make it wait — a goal in one project can gate a milestone
in another — or use the picker when the other end is three projects away.
Cycles are refused with the loop spelled out. Line style says where each edge
came from: one you drew, an order you set, or an order the app guessed. A guess
is always overruled by a statement, and never causes a rejection.

A dozen projects is a hundred cards, so most of the toolbar is about seeing
less: filter to the projects you care about, collapse a band to its title, hide
finished work, or focus one node and see only what it touches. Search dims the
misses rather than removing them, so the board keeps its shape.

**The spreadsheet** is the same board as a grid, editable the way a spreadsheet
is: click a cell, Enter commits and moves down, Tab moves right.

**Experiments** take what you actually specify — samples, scaffold type, cells
per scaffold, when the scaffolds arrive, seeding date, culture length, media
transitions — and derive a dated timeline from it. Media changes and the
endpoint appear on the calendar and on the day they are due.

**Scaffolds** tracks what you have made and what state it is in. Select some
batches, pick EDC/NHS or genipin, and every timed step of the protocol lands in
your to-do list automatically. Protocols are ordinary editable records; the
shipped timings are a starting point, not a prescription.

**Undo reverts the whole image**, and it survives closing the app.

## What it deliberately does not do

There is no scheduler. Nothing ranks your work, assigns it to days, or decides
what you should do next. You pick from a pool.

What it *does* have is preset reminders: a protocol says "wash at +4 h" and an
experiment says "switch media on day 7", so those become dated items. Fixed
offsets, no inference. Cells do not wait for a ready pool, and that is the only
reason anything here has a date you did not choose.

Deadlines are soft. Nothing raises an alarm; overdue things simply stay on the
list and say how late they are.

## Your data

Plain UTF-8 text files in a folder. **Settings** tells you where.

```
project tendon-study
  id: n1
  name: Tendon Scaffold Study
  milestone fabrication
    id: n2
    name: Fabrication
    seq: 1
    goal cad-design
      id: n3
      name: CAD design
      seq: 1
      task draft-geometry
        id: n4
        name: Draft geometry in Fusion
        seq: 1
        status: done
        doneAt: 2026-07-12T14:03
```

There is no database. Open the files in any editor, put them in git, sync them
however you like. Serialization is canonical — the same state always produces
the same bytes — so diffs mean something.

## Backing it up, and syncing it

Plain text on one disk is not a backup. **Settings → Back up, sync or restore**
gives you two ways to keep a copy somewhere else, and both restore the vault
*exactly* — dependencies, journal, protocol runs, node ids and all. They are not
the same kind of thing, though, and the app no longer pretends they are.

- **A backup file.** An `.xlsx` workbook with the readable sheets on top and the
  whole vault hidden inside it. Nothing to set up, works offline. Written and
  put away; nothing ever comes back out of it except a restore.
- **A Google spreadsheet.** A two-way *sync*, not a backup: the board goes out
  to a readable tab per project — share it with whoever you like — and edits
  made there come back in. It carries the same hidden vault, so it can be
  restored from as well.

An ordinary **Export** is neither, and does not pretend to be: it is a report,
and it has no columns for half of what the vault holds.

Every file in the backup carries a checksum. A cell that has been edited fails
it and is refused by name rather than quietly restored, and a restore replaces
everything — including deleting what the backup does not have — so you never end
up with a hybrid of two points in time.

Google Sheets needs a one-time setup, spelled out in the dialog: a service
account key you download from Google, and a Google spreadsheet shared with that
account's address. The key stays on your machine and never goes in the vault —
the vault is the thing you share.

**Start again from a backup** stays where it is, at the bottom, under its own
name. Restoring replaces the whole vault from the hidden `Vault` tab; syncing
merges reviewed cells from the readable tabs. Those are different enough that
they will never share a word here.

### Editing in the Google spreadsheet

Tick something done on your phone, rename a task, add a row under a goal, type
a completion period — then **Check for changes** in the Backup and sync dialog
and take what you want, one tick box at a time. (This is the Google spreadsheet,
not the app's own **Spreadsheet** screen, which edits the board directly.)

It works out *whose* change is whose by comparing three things: what was last
sent, what the board says now, and what the Google spreadsheet holds. A cell
changed only in the sheet is proposed; one changed only in the app is left
alone, because the next sync carries it; one changed in both is called a
conflict and never resolved for you. Deletions are reported and never ticked by
default — a row goes missing because somebody meant it, or because they dragged
over it while sorting, and those look identical from here.

Everything you accept applies as one undo step.

**Keep the Google spreadsheet in sync automatically** pushes on a timer, but
only when something has actually changed — and never over an edit made there.
If somebody has typed in it, the sync stops and says so instead of overwriting
them.

### The same vault on another computer

Neither of those moves your work to a second machine, and the same dialog does:
**The same vault on another computer** keeps the vault's own files in a
**private** GitHub repository, so a laptop and a desktop open the same tracker.
It is off until you configure it.

This is not the backup with a different destination. A backup publishes a
*rendering* of the board for people to read and type into; this moves the files
themselves, byte for byte. That is only sound because serialization is canonical
— a commit is a real diff of what changed, so two machines that edited different
projects have not conflicted, and are merged with nothing to report.

Where the same file changed on both, the newer edit wins. Before any merge that
would supersede something of this machine's, that version is committed first, so
the losing side stays in the repository's history and the app links you straight
to it. An edit beats a deletion, because a deletion has no timestamp worth
comparing and discarding work is the worse way to be wrong.

Setup is the repository name and a fine-grained token with **Contents: Read and
write** on that one repository and nothing else. The token is held by the
desktop shell, encrypted by the OS where it offers a keychain, and never written
into the vault. A public repository is refused rather than published to. **Sync
now** is a button; the tick box syncs on a timer. All of it needs the desktop
app — a browser tab has nowhere safe to keep a token.

What crosses is what a backup contains: the `.pt` files. Undo is a local record
of edits to files a sync may have replaced, so it does not survive one — a sync
is a point you cannot step back through. Anything else in that repository, a
README included, is left where it is.

## The command line

`pt` works against the same folder as the app; neither needs to know the other
exists.

```bash
pt today                      # the day's list
pt ready                      # everything unblocked right now
pt done "Draft geometry"      # complete it, and hear what it freed
pt done "Electrospin" --in Q3 # finished some time in Q3; no invented date
pt progress                   # which projects have gone quiet
pt crosslink edc-nhs b12      # start a run; its steps land in the to-do list
pt remind "Order collagen" --on 2026-08-14 --span 3
pt import "My Tracker.xlsx" --preview
pt export board.xlsx           # a report, for a person
pt backup backup.xlsx          # the same, plus the whole vault: restorable
pt restore backup.xlsx --yes   # replace everything from a backup
pt undo
```

`pt help` lists everything. `--json` on any command.
`PROTRACKER_VAULT` sets the folder; it defaults to `~/.protracker/vault`.

## Workbooks, in and out

Import matches columns by header name, so a sheet with only
Project/Milestone/Goal/Task works. It previews what it will do before writing
anything. Strikethrough reads as done; fill colour sets health and never
completion, because something can be finished and still have gone badly.

Export writes the same layout back out, for a supervisor, a collaborator or a
report. It round-trips: cell culture definitions travel in one readable cell
(`samples=24; seed=2026-08-03; days=21; phases=Proliferation@0,Differentiation@7`)
and come back as experiments with their timelines intact.

A **Completed** column carries when something was finished at whatever precision
is honest — `2026-08-14`, `2026-08`, `2026-Q3`, `2026`. Typing a period into it
is itself a statement that the row is done.

## Building it

```bash
npm install
npm run dev          # the app in a browser, no Electron needed
npm test             # 329 unit tests, including 60 simulated days of use
npm run test:e2e     # 230 end-to-end tests
npm run icon         # regenerate the app icon
npm run pack         # a Windows installer in release/
```

## How it is put together

| Path | What lives there |
|---|---|
| `src/core` | Pure domain: model, dependency engine, dates, planner, protocols, experiments. No I/O, no clock, no randomness. |
| `src/store` | The vault text format, canonical serialization, the snapshot history. |
| `src/commands` | The only writer. Every verb returns a delta. |
| `src/cli` | A thin argv client. |
| `src/ui` | React. Renders what it is given and computes nothing about readiness or blocking. |
| `src/desktop` | Electron. A window and file access — nothing else. |

The vault is an *interface*, not a path, which is why the whole application —
command layer included — runs unchanged in a browser tab. That is what lets the
end-to-end tests drive real domain logic with nothing mocked.

`SPEC.md` is the specification, and records the decisions the design follows
from.
