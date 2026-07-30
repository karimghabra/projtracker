/**
 * The vault's text format: a two-space-indented block tree.
 *
 * Every line is exactly one of two things:
 *
 *   kind slug          a block header, opening a nested scope
 *   key: value         a field on the enclosing block
 *
 * That is the whole grammar. It is unambiguous because slugs are restricted to
 * [a-z0-9-] and therefore never contain a colon, and it reads well in a diff
 * because ordinary values are written literally — quoting only appears when a
 * value would otherwise be misread.
 *
 *   project tendon-study
 *     name: Tendon Scaffold Study
 *     milestone fabrication
 *       name: Fabrication
 *       seq: 1
 *
 * Two properties are enforced by tests and depended on everywhere else:
 * serialization is canonical (identical state produces identical bytes), and
 * parsing round-trips exactly.
 */

export interface Block {
  kind: string;
  slug: string;
  /** Insertion-ordered. The serializer decides the canonical order, not this. */
  fields: Map<string, string>;
  children: Block[];
}

export class FormatError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = 'FormatError';
    this.line = line;
  }
}

const INDENT = '  ';
const HEADER_RE = /^([a-z][a-z0-9_]*) ([a-z0-9][a-z0-9-]*)$/;
const FIELD_RE = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/;

export function block(kind: string, slug: string, fields: Record<string, string | undefined> = {}, children: Block[] = []): Block {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) map.set(key, value);
  }
  return { kind, slug, fields: map, children };
}

// ------------------------------------------------------------------ values

/**
 * Values are written bare unless that would lose information: anything with a
 * newline, leading or trailing space, or a leading quote is JSON-quoted. This
 * keeps the common case readable and the uncommon case exact.
 */
export function encodeValue(value: string): string {
  const needsQuoting =
    value !== value.trim() ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes('\t') ||
    value.startsWith('"');
  return needsQuoting ? JSON.stringify(value) : value;
}

export function decodeValue(raw: string): string {
  if (raw.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // A bare value that merely happens to start with a quote. Take it as-is.
    }
  }
  return raw;
}

// ------------------------------------------------------------------- parse

export function parse(text: string): Block[] {
  const roots: Block[] = [];
  // Depth 0 is the file itself; a synthetic root keeps the loop uniform.
  const stack: Block[] = [{ kind: '', slug: '', fields: new Map(), children: roots }];

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, '');
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;

    const indent = countIndent(raw, i + 1);
    const content = raw.slice(indent * INDENT.length);
    const depth = indent + 1;

    if (depth > stack.length) {
      throw new FormatError(`Indented ${depth - stack.length} level(s) too far`, i + 1);
    }
    stack.length = depth;
    const parent = stack[depth - 1]!;

    const header = HEADER_RE.exec(content);
    if (header) {
      const child: Block = { kind: header[1]!, slug: header[2]!, fields: new Map(), children: [] };
      parent.children.push(child);
      stack.push(child);
      continue;
    }

    const field = FIELD_RE.exec(content);
    if (field) {
      if (parent.kind === '') throw new FormatError(`Field "${field[1]}" outside any block`, i + 1);
      parent.fields.set(field[1]!, decodeValue(field[2] ?? ''));
      // A field cannot have children; keep the stack pointing at its block.
      stack.push(parent);
      stack.length = depth;
      continue;
    }

    throw new FormatError(`Cannot parse ${JSON.stringify(content)}`, i + 1);
  }
  return roots;
}

function countIndent(line: string, lineNumber: number): number {
  let spaces = 0;
  while (line[spaces] === ' ') spaces++;
  if (line[spaces] === '\t') throw new FormatError('Tabs are not valid indentation', lineNumber);
  if (spaces % INDENT.length !== 0) {
    throw new FormatError(`Indentation must be a multiple of ${INDENT.length} spaces`, lineNumber);
  }
  return spaces / INDENT.length;
}

// --------------------------------------------------------------- serialize

export function serialize(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) write(b, 0, out);
  // Exactly one trailing newline, LF always. Byte-identical output matters.
  return out.length ? `${out.join('\n')}\n` : '';
}

function write(b: Block, depth: number, out: string[]): void {
  const pad = INDENT.repeat(depth);
  out.push(`${pad}${b.kind} ${b.slug}`);
  for (const [key, value] of b.fields) {
    const encoded = encodeValue(value);
    out.push(encoded === '' ? `${pad}${INDENT}${key}:` : `${pad}${INDENT}${key}: ${encoded}`);
  }
  for (const child of b.children) write(child, depth + 1, out);
}

// ------------------------------------------------------------------ typed

/** Read a field, or undefined when absent or empty. */
export function field(b: Block, key: string): string | undefined {
  const value = b.fields.get(key);
  return value === undefined || value === '' ? undefined : value;
}

export function requireField(b: Block, key: string): string {
  const value = field(b, key);
  if (value === undefined) throw new Error(`Block "${b.kind} ${b.slug}" is missing required field "${key}"`);
  return value;
}

export function numberField(b: Block, key: string, fallback: number): number {
  const value = field(b, key);
  if (value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function boolField(b: Block, key: string, fallback = false): boolean {
  const value = field(b, key);
  if (value === undefined) return fallback;
  return value === 'true' || value === 'yes' || value === '1';
}

export function listField(b: Block, key: string): string[] {
  const value = field(b, key);
  if (value === undefined) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function encodeList(values: readonly string[]): string | undefined {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  return clean.length ? clean.join(', ') : undefined;
}

export function childrenOfKind(b: Block, kind: string): Block[] {
  return b.children.filter((c) => c.kind === kind);
}

/**
 * Fields we did not recognise, so a file written by a newer build can be opened
 * by an older one without losing anything. Round-tripping the unknown is what
 * makes the format safe to evolve.
 */
export function extraFields(b: Block, known: readonly string[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let found = false;
  for (const [key, value] of b.fields) {
    if (known.includes(key)) continue;
    out[key] = value;
    found = true;
  }
  return found ? out : undefined;
}

export function applyExtras(fields: Map<string, string>, extras: Record<string, string> | undefined): void {
  if (!extras) return;
  for (const key of Object.keys(extras).sort()) fields.set(key, extras[key]!);
}
