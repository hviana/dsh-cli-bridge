import { describe, expect, it } from 'vitest';
import {
  LineAssembler,
  parseJsonObject,
  readArray,
  readNumber,
  readObject,
  readString,
} from '../../src/domain/lines.ts';

describe('LineAssembler', () => {
  it('emits only complete lines', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('one\ntw')).toEqual(['one']);
    expect(assembler.push('o\nthree')).toEqual(['two']);
    expect(assembler.flush()).toEqual(['three']);
  });

  it('reassembles a line split across many chunks', () => {
    const assembler = new LineAssembler();
    for (const chunk of ['{"a"', ':1', '}']) {
      expect(assembler.push(chunk)).toEqual([]);
    }
    expect(assembler.flush()).toEqual(['{"a":1}']);
  });

  it('strips CRLF terminators but keeps a bare CR inside a line', () => {
    const assembler = new LineAssembler();
    expect(assembler.push('a\r\nb\rc\n')).toEqual(['a', 'b\rc']);
  });

  it('flushes nothing when the stream ended on a terminator', () => {
    const assembler = new LineAssembler();
    assembler.push('done\n');
    expect(assembler.flush()).toEqual([]);
  });

  it('is idempotent after flushing', () => {
    const assembler = new LineAssembler();
    assembler.push('tail');
    expect(assembler.flush()).toEqual(['tail']);
    expect(assembler.flush()).toEqual([]);
  });
});

describe('parseJsonObject', () => {
  it('parses a JSON object line', () => {
    expect(parseJsonObject(' {"type":"x"} ')).toEqual({ type: 'x' });
  });

  it.each([
    ['blank', '   '],
    ['prose', 'Welcome to the CLI'],
    ['broken json', '{"type":'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"text"'],
  ])('returns undefined for %s', (_label, line) => {
    expect(parseJsonObject(line)).toBeUndefined();
  });
});

describe('field readers', () => {
  const source = { s: 'text', n: 7, bad: NaN, o: { k: 1 }, a: [1, 2] };

  it('read matching types only', () => {
    expect(readString(source, 's')).toBe('text');
    expect(readString(source, 'n')).toBeUndefined();
    expect(readNumber(source, 'n')).toBe(7);
    expect(readNumber(source, 'bad')).toBeUndefined();
    expect(readObject(source, 'o')).toEqual({ k: 1 });
    expect(readObject(source, 'a')).toBeUndefined();
    expect(readArray(source, 'a')).toEqual([1, 2]);
    expect(readArray(source, 'o')).toEqual([]);
  });

  it('tolerate an absent source', () => {
    expect(readString(undefined, 's')).toBeUndefined();
    expect(readArray(undefined, 'a')).toEqual([]);
  });
});
