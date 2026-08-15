/**
 * Merging two versions of one vault file against the version they share.
 *
 * The file is the wrong unit. Deleting a task does not delete a file — it
 * rewrites a project file with one fewer record — so two machines that changed
 * different tasks in the same project look exactly like two machines that
 * changed the same thing, and file-level "newest wins" throws one of them away.
 *
 * It cost a real deletion: a task removed on one computer came back on the
 * other, because opening the vault on the second machine rewrote the file for
 * its own reasons — a retired field dropped, an id counter repaired — which
 * made the local copy newer than a change somebody had actually made.
 *
 * A line merge is not enough either. Records sit next to each other with no
 * blank line between them, so renaming one task while the other machine deletes
 * the task below it has no common line in the middle to align on, and any
 * line-based merge calls that a conflict. It is not one: they are two records.
 *
 * So this merges the records themselves. The format makes that cheap — it is
 * `kind slug`, indented `key: value` lines, and nested records, all written by
 * one serializer in a canonical order — and it makes the answer exact: a record
 * one side deleted and the other did not touch is deleted, two records added on
 * different machines are both kept, and only two edits to the same field of the
 * same record are a conflict.
 *
 * Where it cannot decide it says so rather than guessing, and the caller falls
 * back to the rule it had: newest wins, with the loser written down as a commit
 * so it costs a click rather than the work.
 */

interface Rec {
  /** `task n2` — the line that opens the record. */
  head: string;
  /** What identifies this record across machines: its id, or its head line. */
  key: string;
  /** `key: value` lines belonging to this record, in the order written. */
  fields: [string, string][];
  kids: Rec[];
}

const INDENT = '  ';
const HEAD = /^(\s*)([a-z][a-z0-9-]*) (.+)$/;
const FIELD = /^(\s*)([A-Za-z][A-Za-z0-9_-]*): ?(.*)$/;

/**
 * Read a file into records.
 *
 * Returns null for anything that does not look like one — an empty file, or a
 * shape this does not recognise — so the caller can fall back rather than
 * merge something it has misunderstood.
 */
function parseRecords(text: string): Rec[] | null {
  const lines = text.split('\n');
  let at = 0;

  const read = (indent: number): Rec[] => {
    const out: Rec[] = [];
    while (at < lines.length) {
      const line = lines[at]!;
      if (line.trim() === '') {
        at++;
        continue;
      }
      const head = HEAD.exec(line);
      const field = FIELD.exec(line);
      // A field belongs to the record above; a head at or above this level ends
      // the run of children.
      if (!head || field || head[1]!.length < indent) break;
      if (head[1]!.length > indent) break;
      at++;
      const rec: Rec = { head: line.trim(), key: line.trim(), fields: [], kids: [] };
      while (at < lines.length) {
        const next = lines[at]!;
        if (next.trim() === '') {
          at++;
          continue;
        }
        const asField = FIELD.exec(next);
        if (asField && asField[1]!.length === indent + INDENT.length && !HEAD.exec(next)) {
          rec.fields.push([asField[2]!, asField[3]!]);
          at++;
          continue;
        }
        break;
      }
      rec.kids = read(indent + INDENT.length);
      const id = rec.fields.find(([name]) => name === 'id');
      // The id is what survives a rename; without one, the head line is the
      // best identity there is.
      if (id) rec.key = `id:${id[1]}`;
      out.push(rec);
    }
    return out;
  };

  const records = read(0);
  if (records.length === 0 || at < lines.filter((l) => l.trim() !== '').length) {
    // Something was left unread, which means this is not the shape expected.
    return records.length > 0 && at >= lines.length ? records : null;
  }
  return records;
}

function emit(records: Rec[], indent = ''): string[] {
  const out: string[] = [];
  for (const rec of records) {
    out.push(`${indent}${rec.head}`);
    for (const [name, value] of rec.fields) {
      out.push(value === '' ? `${indent}${INDENT}${name}:` : `${indent}${INDENT}${name}: ${value}`);
    }
    out.push(...emit(rec.kids, indent + INDENT));
  }
  return out;
}

const CONFLICT = Symbol('conflict');
type Merged<T> = T | typeof CONFLICT;

const sameFields = (a: [string, string][], b: [string, string][]) =>
  a.length === b.length && a.every(([n, v], i) => b[i]![0] === n && b[i]![1] === v);

/** Field by field, so two machines can edit two properties of one record. */
function mergeFields(
  base: [string, string][],
  mine: [string, string][],
  theirs: [string, string][],
): Merged<[string, string][]> {
  const value = (list: [string, string][], name: string) =>
    list.find(([n]) => n === name)?.[1];
  const names: string[] = [];
  for (const list of [base, mine, theirs]) {
    for (const [name] of list) if (!names.includes(name)) names.push(name);
  }

  const out: [string, string][] = [];
  for (const name of names) {
    const was = value(base, name);
    const ours = value(mine, name);
    const yours = value(theirs, name);
    if (ours === yours) {
      if (ours !== undefined) out.push([name, ours]);
      continue;
    }
    if (ours === was) {
      if (yours !== undefined) out.push([name, yours]);
      continue;
    }
    if (yours === was) {
      if (ours !== undefined) out.push([name, ours]);
      continue;
    }
    return CONFLICT;
  }
  return out;
}

function mergeRecords(
  base: Rec[],
  mine: Rec[],
  theirs: Rec[],
): Merged<Rec[]> {
  const by = (list: Rec[]) => new Map(list.map((rec) => [rec.key, rec]));
  const inBase = by(base);
  const inMine = by(mine);
  const inTheirs = by(theirs);

  const out: Rec[] = [];
  const done = new Set<string>();

  const keep = (key: string, rec: Rec) => {
    done.add(key);
    out.push(rec);
  };

  // Base order first, so surviving records stay where they were.
  for (const was of base) {
    const ours = inMine.get(was.key);
    const yours = inTheirs.get(was.key);
    done.add(was.key);

    if (!ours && !yours) continue;
    // Deleted on one side and untouched on the other: deleted. This is the
    // whole reason for merging by record.
    if (!ours) {
      if (same(was, yours!)) continue;
      keep(was.key, yours!); // They edited it, we deleted it: the edit wins.
      continue;
    }
    if (!yours) {
      if (same(was, ours)) continue;
      keep(was.key, ours);
      continue;
    }

    const merged = mergeOne(was, ours, yours);
    if (merged === CONFLICT) return CONFLICT;
    keep(was.key, merged);
  }

  // Then anything either side added, ours first.
  for (const list of [mine, theirs]) {
    for (const rec of list) {
      if (done.has(rec.key) || inBase.has(rec.key)) continue;
      const other = list === mine ? inTheirs.get(rec.key) : inMine.get(rec.key);
      if (other && !same(rec, other)) return CONFLICT;
      keep(rec.key, rec);
    }
  }

  return out;
}

const same = (a: Rec, b: Rec): boolean =>
  a.head === b.head &&
  sameFields(a.fields, b.fields) &&
  a.kids.length === b.kids.length &&
  a.kids.every((kid, at) => same(kid, b.kids[at]!));

function mergeOne(base: Rec, mine: Rec, theirs: Rec): Merged<Rec> {
  if (same(mine, theirs)) return mine;
  if (same(base, mine)) return theirs;
  if (same(base, theirs)) return mine;

  const fields = mergeFields(base.fields, mine.fields, theirs.fields);
  if (fields === CONFLICT) return CONFLICT;
  const kids = mergeRecords(base.kids, mine.kids, theirs.kids);
  if (kids === CONFLICT) return CONFLICT;
  // The head is the kind and the slug; a slug follows the name, so two machines
  // renaming one record differently lands here rather than being papered over.
  if (mine.head !== theirs.head && base.head !== mine.head && base.head !== theirs.head) {
    return CONFLICT;
  }
  const head = base.head === mine.head ? theirs.head : mine.head;
  return { head, key: mine.key, fields, kids };
}

export interface Merge3 {
  /** The merged text, when there was nothing to disagree about. */
  text?: string;
  /** True when both sides changed the same thing differently. */
  conflict: boolean;
}

export function merge3(base: string, mine: string, theirs: string): Merge3 {
  if (mine === theirs) return { text: mine, conflict: false };
  if (base === mine) return { text: theirs, conflict: false };
  if (base === theirs) return { text: mine, conflict: false };

  const b = parseRecords(base);
  const m = parseRecords(mine);
  const t = parseRecords(theirs);
  if (!b || !m || !t) return { conflict: true };

  const merged = mergeRecords(b, m, t);
  if (merged === CONFLICT) return { conflict: true };

  // Every vault file the serializer writes ends in a newline.
  return { text: `${emit(merged).join('\n')}\n`, conflict: false };
}
