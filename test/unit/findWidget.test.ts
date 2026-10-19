import { SearchQuery } from '@codemirror/search';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { matchCount } from '../../src/webview/ui/findWidget';

const at = (doc: string, from: number, to: number) => EditorState.create({ doc, selection: EditorSelection.single(from, to) });

describe('find bar match count', () => {
  it('counts every match and knows which one is selected', () => {
    const state = at('the cat and the hat and the bat', 12, 15);
    expect(matchCount(state, new SearchQuery({ search: 'the' }))).toEqual({ total: 3, current: 2, capped: false });
  });

  it('reports no current match when the selection is not on one', () => {
    expect(matchCount(at('aa aa', 0, 0), new SearchQuery({ search: 'aa' }))).toEqual({ total: 2, current: 0, capped: false });
  });

  it('respects case, whole word and regular expressions', () => {
    const state = at('Cat cat category', 0, 0);
    expect(matchCount(state, new SearchQuery({ search: 'cat' })).total).toBe(3);
    expect(matchCount(state, new SearchQuery({ search: 'cat', caseSensitive: true })).total).toBe(2);
    expect(matchCount(state, new SearchQuery({ search: 'cat', wholeWord: true })).total).toBe(2);
    expect(matchCount(state, new SearchQuery({ search: 'c.t', regexp: true })).total).toBe(3);
  });

  it('counts nothing for an empty or invalid query', () => {
    expect(matchCount(at('abc', 0, 0), new SearchQuery({ search: '' })).total).toBe(0);
    expect(matchCount(at('abc', 0, 0), new SearchQuery({ search: '(', regexp: true })).total).toBe(0);
  });

  it('stops counting at a limit on huge documents', () => {
    const result = matchCount(at('a '.repeat(20000), 0, 0), new SearchQuery({ search: 'a' }));
    expect(result).toEqual({ total: 10000, current: 0, capped: true });
  });
});
