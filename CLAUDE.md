Read `SPEC.md` first — it records the decisions everything else follows from,
and most questions about "why is it like this" are answered there.
`AGENT.md` is the guide for an agent *operating* the tool through the CLI;
`BACKLOG.md` is where wants wait until they are built.

Invariants, in the order they matter:

1. **`src/core` is pure.** No I/O, no clock, no randomness. The current time
   enters through a `Clock` passed in from outside. If a core function needs to
   know what day it is, the day is a parameter.
2. **The command layer is the only writer.** Clients validate nothing and
   compute nothing about readiness, blocking or dates. If a component works out
   whether something is blocked, that is a bug in `views.ts`.
3. **Every mutating verb returns a delta** and is one undo step. Several verbs
   that express one decision go in `app.transaction`.
4. **Serialization is canonical.** Identical state produces identical bytes, and
   state is canonicalised in memory after every mutation so "memory equals disk"
   is exact rather than equivalent.
5. **Nothing dated disappears silently.** Overdue reminders and unfinished tasks
   roll forward and say how late they are.
6. **There is no scheduler.** Preset reminders compute dates from offsets the
   user gave. Nothing ranks or assigns work.
7. **The backup restores bytes, not a reading of them.** Anything that changes
   what is written to disk must keep `tests/unit/compatibility.test.ts` green —
   it holds a frozen 1.3.2 vault, and the user has live data in that format.

Testing: unit tests for behaviour, Playwright for the real UI against the real
command layer, and `tests/unit/fieldtest.test.ts` — sixty simulated days that
assert eight invariants after every single day. It has found bugs the other two
could not; extend it when you add a surface.

Never merge with a red suite.
