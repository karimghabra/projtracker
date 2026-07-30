import { describe, expect, it } from 'vitest';
import {
  FormatError,
  block,
  decodeValue,
  encodeValue,
  parse,
  serialize,
} from '@store/format.ts';

describe('block grammar', () => {
  it('parses headers and fields', () => {
    const text = [
      'project tendon-study',
      '  name: Tendon Scaffold Study',
      '  milestone fabrication',
      '    name: Fabrication',
      '    seq: 1',
      '',
    ].join('\n');

    const [project] = parse(text);
    expect(project!.kind).toBe('project');
    expect(project!.slug).toBe('tendon-study');
    expect(project!.fields.get('name')).toBe('Tendon Scaffold Study');
    expect(project!.children).toHaveLength(1);

    const milestone = project!.children[0]!;
    expect(milestone.kind).toBe('milestone');
    expect(milestone.fields.get('seq')).toBe('1');
  });

  it('ignores blank lines and comments', () => {
    const blocks = parse(['# a note', '', 'project p', '  # inline', '  name: P', ''].join('\n'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.fields.get('name')).toBe('P');
  });

  it('allows an empty value', () => {
    const [b] = parse('project p\n  notes:\n');
    expect(b!.fields.get('notes')).toBe('');
    expect(serialize(parse('project p\n  notes:\n'))).toBe('project p\n  notes:\n');
  });

  it('keeps colons inside values', () => {
    const [b] = parse('task t\n  name: Ratio: 3:1 in PBS\n');
    expect(b!.fields.get('name')).toBe('Ratio: 3:1 in PBS');
  });

  it('nests to arbitrary depth', () => {
    const text = 'project p\n  milestone m\n    goal g\n      task t\n        name: Deep\n';
    const task = parse(text)[0]!.children[0]!.children[0]!.children[0]!;
    expect(task.fields.get('name')).toBe('Deep');
  });

  it('reports where a bad line is', () => {
    expect(() => parse('project p\n\tname: tabbed\n')).toThrow(FormatError);
    expect(() => parse('project p\n   name: three spaces\n')).toThrow(/multiple of 2/);
    expect(() => parse('name: orphan\n')).toThrow(/outside any block/);
    expect(() => parse('project p\n      too: deep\n')).toThrow(/too far/);
    expect(() => parse('project p\n  !!bad!!\n')).toThrow(/Cannot parse/);

    try {
      parse('project p\n  ok: 1\n  !!bad!!\n');
    } catch (error) {
      expect((error as FormatError).line).toBe(3);
    }
  });
});

describe('value encoding', () => {
  const cases = [
    'plain text',
    'with: a colon',
    'trailing space ',
    ' leading space',
    'multi\nline\ntext',
    'tab\there',
    '"already quoted"',
    'back\\slash',
    '',
    'emoji ✅ and ünïcode',
    'a'.repeat(500),
  ];

  it('round-trips every awkward value', () => {
    for (const value of cases) {
      expect(decodeValue(encodeValue(value))).toBe(value);
    }
  });

  it('leaves ordinary values unquoted so diffs stay readable', () => {
    expect(encodeValue('Draft geometry in Fusion')).toBe('Draft geometry in Fusion');
    expect(encodeValue('Ratio: 3:1')).toBe('Ratio: 3:1');
  });

  it('quotes only when it must', () => {
    expect(encodeValue('two\nlines')).toBe('"two\\nlines"');
    expect(encodeValue('trailing ')).toBe('"trailing "');
  });

  it('survives a full parse cycle with awkward values', () => {
    const b = block('task', 't');
    cases.forEach((value, i) => b.fields.set(`f${i}`, value));
    const reparsed = parse(serialize([b]))[0]!;
    cases.forEach((value, i) => expect(reparsed.fields.get(`f${i}`)).toBe(value));
  });
});

describe('serialization is canonical', () => {
  it('always ends with exactly one newline', () => {
    expect(serialize([block('project', 'p', { name: 'P' })])).toBe('project p\n  name: P\n');
  });

  it('emits nothing for nothing', () => {
    expect(serialize([])).toBe('');
  });

  it('never emits CRLF', () => {
    const text = serialize([block('project', 'p', { name: 'has\r\ncrlf' })]);
    expect(text.includes('\r')).toBe(false);
  });

  it('is a fixed point: serialize(parse(x)) === x', () => {
    const original = [
      'project tendon-study',
      '  name: Tendon Scaffold Study',
      '  status: active',
      '  milestone fabrication',
      '    name: Fabrication',
      '    seq: 1',
      '    goal cad',
      '      name: CAD design',
      '      seq: 1',
      '      task draft',
        '        name: Draft geometry',
      '        seq: 1',
      '',
    ].join('\n');
    expect(serialize(parse(original))).toBe(original);
    expect(serialize(parse(serialize(parse(original))))).toBe(original);
  });

  it('tolerates CRLF input and normalises it', () => {
    const crlf = 'project p\r\n  name: P\r\n';
    expect(serialize(parse(crlf))).toBe('project p\n  name: P\n');
  });
});
