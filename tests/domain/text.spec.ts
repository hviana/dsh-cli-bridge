import { describe, expect, it } from 'vitest';
import {
  boundHead,
  boundTail,
  byteLength,
  oneLineLabel,
  TRUNCATION_NOTICE,
} from '../../src/domain/text.ts';

describe('byteLength', () => {
  it('counts UTF-8 bytes, not code units', () => {
    expect(byteLength('abc')).toBe(3);
    expect(byteLength('é')).toBe(2);
    expect(byteLength('🚀')).toBe(4);
  });
});

describe('boundHead', () => {
  it('returns short text unchanged', () => {
    expect(boundHead('hello', 64)).toBe('hello');
  });

  it('keeps the head and appends the notice', () => {
    const bounded = boundHead('a'.repeat(500), 64);
    expect(bounded.endsWith(TRUNCATION_NOTICE)).toBe(true);
    expect(byteLength(bounded)).toBeLessThanOrEqual(64);
  });

  it('never splits a multi-byte code point', () => {
    // 40 rockets = 160 bytes; any budget lands mid-sequence for most cuts.
    for (
      let budget = byteLength(TRUNCATION_NOTICE) + 1;
      budget < 80;
      budget += 1
    ) {
      const bounded = boundHead('🚀'.repeat(40), budget);
      expect(bounded).not.toContain('�');
      expect(byteLength(bounded)).toBeLessThanOrEqual(budget);
    }
  });

  it('yields an empty string for a non-positive budget', () => {
    expect(boundHead('anything', 0)).toBe('');
  });
});

describe('boundTail', () => {
  it('keeps the newest bytes', () => {
    expect(boundTail('abcdefghij', 4)).toBe('ghij');
  });

  it('never splits a multi-byte code point', () => {
    for (let budget = 1; budget < 40; budget += 1) {
      const bounded = boundTail('é'.repeat(20), budget);
      expect(bounded).not.toContain('�');
      expect(byteLength(bounded)).toBeLessThanOrEqual(budget);
    }
  });
});

describe('oneLineLabel', () => {
  it('takes the first non-empty line and collapses whitespace', () => {
    expect(oneLineLabel('\n\n  refactor   the\tparser  \nand more', 80)).toBe(
      'refactor the parser',
    );
  });

  it('ellipsizes past the budget', () => {
    expect(oneLineLabel('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('survives an empty prompt', () => {
    expect(oneLineLabel('   \n  ', 10)).toBe('');
  });
});
