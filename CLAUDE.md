Read tracker_spec.md first — it is the current spec (v2, a restart on the logic:
no Excel import, goal kinds, cell culture experiments, scaffold inventory with
crosslink protocols, text-as-truth, undo/redo). Then scheduler_spec.md, which it
supersedes in part and still governs §8.1 layering, and HANDOFF.md for what is
actually built and why it diverges. There is no SPEC.md.

Strict layering per scheduler_spec.md §8.1: core library has no I/O, all clients
go through the command layer, every mutating verb returns a state delta. All
logic must be unit-tested.
