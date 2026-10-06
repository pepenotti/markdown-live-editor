import { describe, expect, it } from 'vitest';
import { applyChanges, countWords, extractHeadings, minimalDiff, positionAt, slugify, toLF } from '../../src/shared/textUtil';

describe('textUtil', () => {
  it('normalises line endings', () => {
    expect(toLF('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('finds the smallest replacement', () => {
    expect(minimalDiff('abc', 'abc')).toBeNull();
    expect(minimalDiff('hello world', 'hello brave world')).toEqual({ from: 6, toA: 6, toB: 12 });
    expect(minimalDiff('aaa', 'aa')).toEqual({ from: 2, toA: 3, toB: 2 });
    expect(minimalDiff('', 'x')).toEqual({ from: 0, toA: 0, toB: 1 });
  });

  it('does not split surrogate pairs', () => {
    const d = minimalDiff('a😀b', 'a😁b')!;
    expect('a😀b'.slice(0, d.from) + 'a😁b'.slice(d.from, d.toB) + 'a😀b'.slice(d.toA)).toBe('a😁b');
    expect(d.from).toBe(1);
    expect(d.toA).toBe(3);
  });

  it('applies changes that all refer to the original text', () => {
    const c = (from: number, to: number, insert: string) => ({ from, to, insert, fromLine: 0, fromCh: from, toLine: 0, toCh: to });
    expect(applyChanges('abcdef', [c(0, 1, 'X'), c(3, 5, '')])).toBe('Xbcf');
    expect(applyChanges('abc', [c(2, 1, '')])).toBeNull();
    expect(applyChanges('abc', [c(1, 2, ''), c(0, 1, '')])).toBeNull();
    expect(applyChanges('abc', [c(0, 9, '')])).toBeNull();
  });

  it('converts offsets to positions', () => {
    expect(positionAt('ab\ncd\n', 0)).toEqual({ line: 0, ch: 0 });
    expect(positionAt('ab\ncd\n', 2)).toEqual({ line: 0, ch: 2 });
    expect(positionAt('ab\ncd\n', 3)).toEqual({ line: 1, ch: 0 });
    expect(positionAt('ab\ncd\n', 6)).toEqual({ line: 2, ch: 0 });
  });

  it('counts words', () => {
    expect(countWords("Don't stop — it's a well-known fact, 42 times.")).toBe(8);
    expect(countWords('')).toBe(0);
  });

  it('slugifies headings like GitHub', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  API v2.0 (beta) ')).toBe('api-v20-beta');
  });

  it('extracts headings and skips code and front matter', () => {
    const md = ['---', 'title: x', '# not a heading', '---', '# One', '', '```', '# in code', '```', '## Two ##', '####### seven'].join('\n');
    expect(extractHeadings(md)).toEqual([
      { level: 1, text: 'One', line: 4 },
      { level: 2, text: 'Two', line: 9 },
    ]);
  });
});
