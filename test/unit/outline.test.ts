import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { currentHeading, filterOutline, headingAt, outlineFromTree, outlineMayChange, sameOutline } from '../../src/webview/outline';
import { stateOf } from './helpers';

const doc = (...lines: string[]) => lines.join('\n');
const outlineOf = (state: EditorState) => outlineFromTree(syntaxTree(state), (from, to) => state.doc.sliceString(from, to));
const outline = (text: string, wikiLinks = false) => outlineOf(stateOf(text, [], { wikiLinks }));
const brief = (text: string) => outline(text).map((h) => `${'  '.repeat(h.depth)}${h.level}:${h.text}`);

describe('outline: the headings of a document', () => {
  it('lists ATX and setext headings in order, nested by level', () => {
    const md = doc('# Title', '', 'Intro', '', 'Install', '-------', '', '### Deep', '', 'Usage', '=====', '', '## Next');
    expect(brief(md)).toEqual(['1:Title', '  2:Install', '    3:Deep', '1:Usage', '  2:Next']);
  });

  it('knows where each heading starts, and its parent', () => {
    const md = doc('# A', 'text', '## B', '#### C', '## D');
    const items = outline(md);
    expect(items.map((h) => h.from)).toEqual([0, md.indexOf('## B'), md.indexOf('#### C'), md.indexOf('## D')]);
    expect(items.map((h) => h.parent)).toEqual([-1, 0, 1, 0]);
    // A skipped level does not indent twice.
    expect(items.map((h) => h.depth)).toEqual([0, 1, 2, 1]);
  });

  it('shows the text without Markdown markers', () => {
    const md = doc(
      '# The *quick* **brown** `fox` ##',
      '## [Link text](https://example.com "title") and ![logo](logo.png)',
      '## ~~Old~~ new \\*escaped\\* &amp; more',
      '## Ref [label][ref] and footnote[^1] <span>tag</span>',
      '## Math $x^2$ and <https://auto.link> or https://bare.link',
      'Setext with _emphasis_',
      '---',
    );
    expect(outline(md).map((h) => h.text)).toEqual([
      'The quick brown fox',
      'Link text and logo',
      'Old new *escaped* & more',
      'Ref label and footnote tag',
      'Math x^2 and https://auto.link or https://bare.link',
      'Setext with emphasis',
    ]);
  });

  it('reads a wiki link by what it shows', () => {
    expect(outline('# See [[Note|the note]] and [[Other]]', true).map((h) => h.text)).toEqual(['See the note and Other']);
  });

  it('leaves out what only looks like a heading: code, front matter, HTML and math', () => {
    const md = doc(
      '---',
      'title: x',
      '# not a heading',
      '---',
      '',
      '# Real',
      '',
      '```md',
      '# in a fence',
      '```',
      '',
      '    # indented code',
      '',
      '<div>',
      '# in HTML',
      '</div>',
      '',
      '$$',
      '# in math',
      '$$',
      '',
      '## Also real',
    );
    expect(brief(md)).toEqual(['1:Real', '  2:Also real']);
  });

  it('keeps an empty heading, with empty text', () => {
    expect(outline(doc('#', '', '## Two')).map((h) => [h.level, h.text])).toEqual([
      [1, ''],
      [2, 'Two'],
    ]);
  });

  it('collapses line breaks of a setext heading', () => {
    expect(outline(doc('Two', 'lines', '===')).map((h) => h.text)).toEqual(['Two lines']);
  });

  it('compares outlines by what they show, not where', () => {
    const a = outline(doc('# A', '## B'));
    const b = outline(doc('text', '', '# A', '## B'));
    expect(sameOutline(a, b)).toBe(true);
    expect(sameOutline(a, outline(doc('# A', '## C')))).toBe(false);
    expect(sameOutline(a, outline(doc('# A', '### B')))).toBe(false);
    expect(sameOutline(a, outline('# A'))).toBe(false);
  });
});

describe('outline: the filter', () => {
  const items = outline(doc('# Guide', '## Install', '### On macOS', '### On Linux', '## Usage', '### Linux tips', '# Appendix'));
  const names = (set: Set<number>) => [...set].sort((x, y) => x - y).map((i) => items[i].text);

  it('shows everything without a query', () => {
    expect(filterOutline(items, '')).toBeNull();
    expect(filterOutline(items, '   ')).toBeNull();
  });

  it('matches ignoring case and keeps the parents of a match', () => {
    const result = filterOutline(items, 'LINUX')!;
    expect(names(result.matches)).toEqual(['On Linux', 'Linux tips']);
    expect(names(result.visible)).toEqual(['Guide', 'Install', 'On Linux', 'Usage', 'Linux tips']);
  });

  it('shows nothing when nothing matches', () => {
    const result = filterOutline(items, 'windows')!;
    expect(result.matches.size).toBe(0);
    expect(result.visible.size).toBe(0);
  });

  it('a parent that matches itself stays a match', () => {
    const result = filterOutline(items, 'in')!;
    expect(names(result.matches)).toEqual(['Install', 'On Linux', 'Linux tips']);
    expect(names(result.visible)).toEqual(['Guide', 'Install', 'On Linux', 'Usage', 'Linux tips']);
  });
});

describe('outline: the current heading', () => {
  const md = doc('Preface', '', '# One', 'text one', '', '## Two', 'text two', '', '# Three', 'end');
  const items = outline(md);
  const at = (s: string) => md.indexOf(s);

  it('is the last heading at or above a position', () => {
    expect(headingAt(items, 0)).toBe(-1);
    expect(headingAt(items, at('# One'))).toBe(0);
    expect(headingAt(items, at('text one'))).toBe(0);
    expect(headingAt(items, at('## Two') - 1)).toBe(0);
    expect(headingAt(items, at('text two'))).toBe(1);
    expect(headingAt(items, md.length)).toBe(2);
    expect(headingAt([], 10)).toBe(-1);
  });

  it('follows the cursor, or the top of the view while scrolling', () => {
    expect(currentHeading(items, { cursor: at('text two'), top: 0, follow: 'cursor' })).toBe(1);
    expect(currentHeading(items, { cursor: at('text two'), top: at('end'), follow: 'scroll' })).toBe(2);
    expect(currentHeading(items, { cursor: at('end'), top: 0, follow: 'scroll' })).toBe(-1);
  });
});

describe('outline: when to rebuild', () => {
  const md = doc('# Title', '', 'A paragraph of text.', '', 'Setext', 'line two', '------', '', '```', 'code', '```', '', 'Last words.');
  const edit = (from: number, to: number, insert: string) => {
    const state = stateOf(md);
    const tr = state.update({ changes: { from, to, insert } });
    return outlineMayChange(state.doc, tr.state.doc, tr.changes);
  };
  const at = (s: string) => md.indexOf(s);

  it('does not for typing in an ordinary paragraph', () => {
    expect(edit(at('paragraph'), at('paragraph'), 'long ')).toBe(false);
    expect(edit(at('Last'), at('Last') + 4, 'Final')).toBe(false);
    // A new line in the paragraph, and a new paragraph.
    expect(edit(at(' of text'), at(' of text'), '\n')).toBe(false);
    expect(edit(at('Last words.') + 11, at('Last words.') + 11, '\n\nMore')).toBe(false);
  });

  it('does for typing in a heading or making one', () => {
    expect(edit(at('Title'), at('Title'), 'New ')).toBe(true);
    expect(edit(at('A paragraph'), at('A paragraph'), '## ')).toBe(true);
    expect(edit(at('A paragraph'), at('A paragraph'), '#')).toBe(true);
    // Removing the marker of a heading.
    expect(edit(0, 2, '')).toBe(true);
  });

  it('does for the text of a setext heading, its underline, or a blank line that splits it', () => {
    expect(edit(at('Setext'), at('Setext'), 'A ')).toBe(true);
    expect(edit(at('line two'), at('line two'), 'x')).toBe(true);
    expect(edit(at('------'), at('------') + 1, '')).toBe(true);
    expect(edit(at('line two') - 1, at('line two') - 1, '\n')).toBe(true);
    // Underlining a paragraph.
    expect(edit(at('A paragraph of text.') + 20, at('A paragraph of text.') + 20, '\n===')).toBe(true);
  });

  it('does for code fences, which hide headings', () => {
    expect(edit(at('code'), at('code'), 'x')).toBe(false);
    expect(edit(at('```'), at('```') + 3, '')).toBe(true);
  });
});
