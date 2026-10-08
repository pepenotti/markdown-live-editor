import { describe, expect, it } from 'vitest';
import type { Mode } from '../../src/shared/protocol';
import { extractHeadings, headingPlainText, headingSlugs } from '../../src/shared/textUtil';
import { DEFAULT_TOC_OPTIONS, findTocMarkers, isTocMarker, parseTocLevels, tocBlock, tocLines, type TocOptions, tocUpdate } from '../../src/shared/toc';
import { insertToc } from '../../src/webview/commands/format';
import { blockField, protectedAt } from '../../src/webview/decorations/blocks';
import { editGuard } from '../../src/webview/guard';
import { modeField } from '../../src/webview/modes';
import { run, show, stateOf } from './helpers';

const opts = (o: Partial<TocOptions> = {}): TocOptions => ({ ...DEFAULT_TOC_OPTIONS, ...o });
const doc = (...lines: string[]) => lines.join('\n');

/** Applies the update the way an editor would. */
function updated(text: string, options: TocOptions = DEFAULT_TOC_OPTIONS): string {
  const edit = tocUpdate(text, options);
  return edit ? text.slice(0, edit.from) + edit.insert + text.slice(edit.to) : text;
}

describe('heading anchors', () => {
  it('reduces a heading to the text a reader sees', () => {
    expect(headingPlainText('**Bold** and *italic* and `code`')).toBe('Bold and italic and code');
    expect(headingPlainText('_emphasis_ and __strong__')).toBe('emphasis and strong');
    expect(headingPlainText('See [the docs](https://example.com/a_b) now')).toBe('See the docs now');
    expect(headingPlainText('A [reference][ref] link')).toBe('A reference link');
    expect(headingPlainText('![logo](logo.png) Project')).toBe('logo Project');
    expect(headingPlainText('~~old~~ new')).toBe('old new');
  });

  it('drops footnote references', () => {
    expect(headingPlainText('Results[^1] and method[^note]')).toBe('Results and method');
    expect(headingSlugs([{ text: 'Results[^1]' }])).toEqual(['results']);
    expect(tocLines('## Results[^1]\n\n[^1]: A note.')).toEqual(['- [Results](#results)']);
  });

  it('keeps underscores that are part of a word', () => {
    expect(headingPlainText('snake_case_name')).toBe('snake_case_name');
    expect(headingSlugs([{ text: 'The `my_var` option' }])).toEqual(['the-my_var-option']);
  });

  it('numbers repeated headings like GitHub', () => {
    const slugs = headingSlugs([{ text: 'Usage' }, { text: 'Install' }, { text: '*Usage*' }, { text: 'Usage!' }]);
    expect(slugs).toEqual(['usage', 'install', 'usage-1', 'usage-2']);
  });

  it('slugs links by their text', () => {
    expect(headingSlugs([{ text: 'Read [the Guide](guide.md)' }])).toEqual(['read-the-guide']);
  });
});

describe('table of contents: options', () => {
  it('reads level ranges', () => {
    expect(parseTocLevels('2..4')).toEqual({ minLevel: 2, maxLevel: 4 });
    expect(parseTocLevels(' 1 .. 6 ')).toEqual({ minLevel: 1, maxLevel: 6 });
    expect(parseTocLevels('2-3')).toEqual({ minLevel: 2, maxLevel: 3 });
    expect(parseTocLevels('3')).toEqual({ minLevel: 3, maxLevel: 3 });
    expect(parseTocLevels('4..2')).toEqual({ minLevel: 2, maxLevel: 4 });
  });

  it('falls back to every level for anything else', () => {
    for (const bad of ['', 'all', '0..9', '2..', '..3', '7', null, undefined, 3]) {
      expect(parseTocLevels(bad)).toEqual({ minLevel: 1, maxLevel: 6 });
    }
  });
});

describe('table of contents: the list', () => {
  it('nests by heading level', () => {
    const md = doc('## Getting started', '### Install', '### Configure', '#### Advanced', '## Usage');
    expect(tocLines(md)).toEqual([
      '- [Getting started](#getting-started)',
      '  - [Install](#install)',
      '  - [Configure](#configure)',
      '    - [Advanced](#advanced)',
      '- [Usage](#usage)',
    ]);
  });

  it('leaves out a lone H1, the title', () => {
    const md = doc('# My project', '', '## One', '## Two');
    expect(tocLines(md)).toEqual(['- [One](#one)', '- [Two](#two)']);
  });

  it('lists H1 headings when there are several', () => {
    const md = doc('# Part one', '## Chapter', '# Part two');
    expect(tocLines(md)).toEqual(['- [Part one](#part-one)', '  - [Chapter](#chapter)', '- [Part two](#part-two)']);
  });

  it('indents one step for a skipped level', () => {
    const md = doc('# A', '### Deep under A', '# B', '#### Deeper under B', '## Back up');
    expect(tocLines(md)).toEqual([
      '- [A](#a)',
      '  - [Deep under A](#deep-under-a)',
      '- [B](#b)',
      '  - [Deeper under B](#deeper-under-b)',
      '  - [Back up](#back-up)',
    ]);
  });

  it('starts at the margin when the first heading is a deep one', () => {
    expect(tocLines(doc('### Deep first', '## Then shallow'))).toEqual(['- [Deep first](#deep-first)', '- [Then shallow](#then-shallow)']);
  });

  it('gives repeated headings numbered anchors', () => {
    const md = doc('## API', '### Options', '## CLI', '### Options', '### Options');
    expect(tocLines(md)).toEqual([
      '- [API](#api)',
      '  - [Options](#options)',
      '- [CLI](#cli)',
      '  - [Options](#options-1)',
      '  - [Options](#options-2)',
    ]);
  });

  it('counts anchors over every heading, also the ones that are not listed', () => {
    // The title and the H4 are not listed, but they still take "notes" and "notes-2".
    const md = doc('# Notes', '## Notes', '#### Notes', '## Notes');
    expect(tocLines(md, opts({ minLevel: 2, maxLevel: 3 }))).toEqual(['- [Notes](#notes-1)', '- [Notes](#notes-3)']);
  });

  it('ignores headings in code fences and front matter', () => {
    const md = doc('---', 'title: x', '# not a heading', '---', '## Real', '```md', '## In a fence', '```', '~~~', '# Also fenced', '~~~', '## Also real');
    expect(tocLines(md)).toEqual(['- [Real](#real)', '- [Also real](#also-real)']);
  });

  it('strips inline markers from the link text', () => {
    const md = doc('## **Bold** `code` _em_ [link](http://x.y)', '## Closed ##');
    expect(tocLines(md)).toEqual(['- [Bold code em link](#bold-code-em-link)', '- [Closed](#closed)']);
  });

  it('escapes brackets that would end the link text', () => {
    expect(tocLines('## array[0] access')).toEqual(['- [array\\[0\\] access](#array0-access)']);
  });

  it('skips empty headings and does not link a heading without an anchor', () => {
    expect(tocLines(doc('## ', '## Fine'))).toEqual(['- [Fine](#fine)']);
    expect(tocLines(doc('## ???', '## Fine'))).toEqual(['- ???', '- [Fine](#fine)']);
  });

  it('respects the level range', () => {
    const md = doc('# Title', '## Two', '### Three', '#### Four', '##### Five');
    expect(tocLines(md, opts({ minLevel: 3, maxLevel: 4 }))).toEqual(['- [Three](#three)', '  - [Four](#four)']);
    expect(tocLines(md, opts({ minLevel: 2, maxLevel: 2 }))).toEqual(['- [Two](#two)']);
  });

  it('writes a numbered list with nested lists under the text of their parent', () => {
    const md = doc('## A', '### A1', '### A2', '## B', '### B1', '#### B1a', '## C');
    expect(tocLines(md, opts({ ordered: true }))).toEqual([
      '1. [A](#a)',
      '   1. [A1](#a1)',
      '   2. [A2](#a2)',
      '2. [B](#b)',
      '   1. [B1](#b1)',
      '      1. [B1a](#b1a)',
      '3. [C](#c)',
    ]);
  });

  it('indents further under a two-digit number', () => {
    const md = Array.from({ length: 10 }, (_, i) => `## H${i + 1}`).join('\n') + '\n### Child';
    const lines = tocLines(md, opts({ ordered: true }));
    expect(lines.slice(-2)).toEqual(['10. [H10](#h10)', '    1. [Child](#child)']);
  });

  it('is empty for a document without headings', () => {
    expect(tocLines('Just text.\n')).toEqual([]);
    expect(tocBlock('Just text.\n')).toBe('<!-- toc -->\n<!-- tocstop -->');
  });

  it('builds the block with its markers', () => {
    expect(tocBlock(doc('# T', '## A', '### B'))).toBe(doc('<!-- toc -->', '- [A](#a)', '  - [B](#b)', '<!-- tocstop -->'));
  });
});

describe('table of contents: markers', () => {
  it('finds the pair', () => {
    expect(findTocMarkers(doc('# T', '', '<!-- toc -->', '- old', '<!-- tocstop -->', '', '## A'))).toEqual({ startLine: 2, endLine: 4 });
  });

  it('accepts loose spacing and capitals', () => {
    expect(findTocMarkers(doc('<!--TOC-->', '  <!--   tocstop   -->  '))).toEqual({ startLine: 0, endLine: 1 });
    expect(isTocMarker('<!-- toc -->')).toBe(true);
    expect(isTocMarker('<!-- tocstop -->')).toBe(true);
    expect(isTocMarker('<!-- todo -->')).toBe(false);
    expect(isTocMarker('text <!-- toc -->')).toBe(false);
  });

  it('needs both markers, in order', () => {
    expect(findTocMarkers(doc('## A', 'text'))).toBeNull();
    expect(findTocMarkers(doc('<!-- toc -->', '## A'))).toBeNull();
    expect(findTocMarkers(doc('<!-- tocstop -->', '## A', '<!-- toc -->'))).toBeNull();
  });

  it('ignores markers in code fences and front matter', () => {
    expect(findTocMarkers(doc('```html', '<!-- toc -->', '<!-- tocstop -->', '```', '## A'))).toBeNull();
    expect(findTocMarkers(doc('---', 'x: 1', '<!-- toc -->', '---', '<!-- tocstop -->'))).toBeNull();
    const md = doc('```', '<!-- toc -->', '```', '<!-- toc -->', '<!-- tocstop -->');
    expect(findTocMarkers(md)).toEqual({ startLine: 3, endLine: 4 });
  });

  it('uses the first pair only', () => {
    const md = doc('<!-- toc -->', '<!-- tocstop -->', '## A', '<!-- toc -->', 'keep me', '<!-- tocstop -->');
    expect(updated(md)).toBe(doc('<!-- toc -->', '- [A](#a)', '<!-- tocstop -->', '## A', '<!-- toc -->', 'keep me', '<!-- tocstop -->'));
  });
});

describe('table of contents: update', () => {
  it('does nothing without markers', () => {
    expect(tocUpdate(doc('# T', '## A', '- [A](#a)'))).toBeNull();
    expect(tocUpdate('')).toBeNull();
  });

  it('fills an empty pair', () => {
    const md = doc('# T', '', '<!-- toc -->', '<!-- tocstop -->', '', '## A', '### B', '');
    expect(updated(md)).toBe(doc('# T', '', '<!-- toc -->', '- [A](#a)', '  - [B](#b)', '<!-- tocstop -->', '', '## A', '### B', ''));
  });

  it('replaces an existing list and nothing else', () => {
    const before = doc('# T', 'intro  ', '', '<!-- toc -->', '- [Old](#old)', '', 'stray text', '<!-- tocstop -->', '', '## New  ', 'body\t', '');
    const edit = tocUpdate(before)!;
    expect(before.slice(edit.from, edit.to)).toBe('- [Old](#old)\n\nstray text\n');
    expect(edit.insert).toBe('- [New](#new)\n');
    const after = updated(before);
    expect(after).toBe(doc('# T', 'intro  ', '', '<!-- toc -->', '- [New](#new)', '<!-- tocstop -->', '', '## New  ', 'body\t', ''));
  });

  it('reports no change when the list is already right', () => {
    const md = doc('# T', '<!-- toc -->', '- [A](#a)', '  - [B](#b)', '<!-- tocstop -->', '## A', '### B');
    expect(tocUpdate(md)).toBeNull();
    expect(tocUpdate(updated(doc('<!-- toc -->', 'x', '<!-- tocstop -->', '## A')))).toBeNull();
  });

  it('empties the list when the headings are gone', () => {
    const md = doc('<!-- toc -->', '- [A](#a)', '<!-- tocstop -->', 'no headings');
    expect(updated(md)).toBe(doc('<!-- toc -->', '<!-- tocstop -->', 'no headings'));
  });

  it('does not list headings that sit between the markers', () => {
    const md = doc('<!-- toc -->', '## Inside', '<!-- tocstop -->', '## Outside');
    expect(updated(md)).toBe(doc('<!-- toc -->', '- [Outside](#outside)', '<!-- tocstop -->', '## Outside'));
  });

  it('keeps CRLF line endings', () => {
    const before = ['# T', '', '<!-- toc -->', '- [Old](#old)', '<!-- tocstop -->', '', '## A', '### B', ''].join('\r\n');
    const edit = tocUpdate(before)!;
    expect(edit.insert).toBe('- [A](#a)\r\n  - [B](#b)\r\n');
    const after = updated(before);
    expect(after).toBe(['# T', '', '<!-- toc -->', '- [A](#a)', '  - [B](#b)', '<!-- tocstop -->', '', '## A', '### B', ''].join('\r\n'));
    expect(/[^\r]\n/.test(after)).toBe(false);
    expect(tocUpdate(after)).toBeNull();
  });

  it('applies the options', () => {
    const md = doc('<!-- toc -->', '<!-- tocstop -->', '# T', '## A', '### B', '## C');
    expect(updated(md, opts({ ordered: true, minLevel: 2, maxLevel: 2 }))).toBe(doc('<!-- toc -->', '1. [A](#a)', '2. [C](#c)', '<!-- tocstop -->', '# T', '## A', '### B', '## C'));
  });

  it('agrees with the heading lines it links to', () => {
    const md = doc('# T', '<!-- toc -->', '<!-- tocstop -->', '## One', '```', '## no', '```', '## Two');
    const after = updated(md);
    expect(extractHeadings(after).map((h) => h.text)).toEqual(['T', 'One', 'Two']);
  });
});

describe('table of contents: editor command', () => {
  it('inserts the block on the empty line of the cursor', () => {
    expect(run('# T\n\n¦\n\n## A\n\n### B\n', insertToc(DEFAULT_TOC_OPTIONS))).toBe('# T\n\n<!-- toc -->\n- [A](#a)\n  - [B](#b)\n<!-- tocstop -->¦\n\n## A\n\n### B\n');
  });

  it('inserts after the line of the cursor when it has text', () => {
    expect(run('# Ti¦tle\n## A\n', insertToc(DEFAULT_TOC_OPTIONS))).toBe('# Title\n\n<!-- toc -->\n- [A](#a)\n<!-- tocstop -->¦\n\n## A\n');
  });

  it('updates the existing one instead of adding a second', () => {
    expect(run('<!-- toc -->\n- stale\n<!-- tocstop -->\n\n## A¦\n', insertToc(opts({ ordered: true })))).toBe('<!-- toc -->\n1. [A](#a)\n<!-- tocstop -->\n\n## A¦\n');
  });

  it('changes nothing when the existing one is up to date', () => {
    const state = stateOf('<!-- toc -->\n- [A](#a)\n<!-- tocstop -->\n\n## A¦\n');
    expect(insertToc(DEFAULT_TOC_OPTIONS)(state)).toBeNull();
  });
});

describe('table of contents: markers in the editor', () => {
  const TOC = '<!-- toc -->\n- [A](#a)\n<!-- tocstop -->';
  const editor = (marked: string, mode: Mode) => stateOf(marked, [modeField.init(() => mode), blockField, editGuard]);

  it('protects the marker lines in full preview only', () => {
    const text = `intro\n\n${TOC}\n\n## A`;
    const start = text.indexOf('<!-- toc');
    const end = text.indexOf('<!-- tocstop');
    const full = editor(text, 'full');
    expect(protectedAt(full, start)).toMatchObject({ from: start, to: start + 12, value: { kind: 'hidden' } });
    expect(protectedAt(full, end + 3)).toMatchObject({ from: end, to: end + 16, value: { kind: 'hidden' } });
    expect(protectedAt(full, text.indexOf('- [A]'))).toBeNull();
    expect(protectedAt(editor(text, 'half'), start)).toBeNull();
    expect(protectedAt(editor(text, 'raw'), start)).toBeNull();
  });

  it('hides only a complete pair, and only the first one', () => {
    const hidden = (text: string, needle: string, from = 0) => protectedAt(editor(text, 'full'), text.indexOf(needle, from))?.value.kind === 'hidden';
    const lone = 'intro\n\n<!-- toc -->\n\n## A';
    expect(hidden(lone, '<!-- toc')).toBe(false);
    const reversed = '<!-- tocstop -->\n\n## A\n\n<!-- toc -->\n';
    expect(hidden(reversed, '<!-- tocstop')).toBe(false);
    expect(hidden(reversed, '<!-- toc -->')).toBe(false);
    const twice = `${TOC}\n\n## A\n\n${TOC}\n`;
    expect(hidden(twice, '<!-- toc -->')).toBe(true);
    expect(hidden(twice, '<!-- toc -->', 20)).toBe(false);
    expect(hidden(twice, '<!-- tocstop', 40)).toBe(false);
    // A stray start marker before the pair: the first start and the first stop after it are the pair.
    const stray = `<!-- toc -->\n\ntext\n\n${TOC}\n\n## A`;
    expect(findTocMarkers(stray)).toEqual({ startLine: 0, endLine: 6 });
    expect(hidden(stray, '<!-- toc -->')).toBe(true);
    expect(hidden(stray, '<!-- toc -->', 5)).toBe(false);
    expect(hidden(stray, '<!-- tocstop')).toBe(true);
  });

  it('does not treat markers inside a quote or an indented list item as the block', () => {
    const quoted = '> <!-- toc -->\n> <!-- tocstop -->\n\n## A';
    expect(findTocMarkers(quoted)).toBeNull();
    expect(protectedAt(editor(quoted, 'full'), 2)).toBeNull();
    const nested = '- item\n\n    <!-- toc -->\n    <!-- tocstop -->\n\n## A';
    expect(findTocMarkers(nested)).toBeNull();
    expect(protectedAt(editor(nested, 'full'), nested.indexOf('<!--'))).toBeNull();
  });

  it('leaves other comments alone', () => {
    const state = editor('<!-- a note -->\n\ntext', 'full');
    expect(protectedAt(state, 0)).toBeNull();
  });

  it('lets the list be regenerated between protected markers', () => {
    const state = editor(`${TOC}\n\n## A\n\n## B¦`, 'full');
    const spec = insertToc(DEFAULT_TOC_OPTIONS)(state)!;
    expect(show(state.update(spec).state)).toBe('<!-- toc -->\n- [A](#a)\n- [B](#b)\n<!-- tocstop -->\n\n## A\n\n## B¦');
  });

  it('refuses an edit that would break a marker but allows removing the whole block', () => {
    const state = editor(`${TOC}\n\n## A`, 'full');
    // Joining the first list line onto the marker line.
    expect(state.update({ changes: { from: 12, to: 13 }, userEvent: 'delete.backward' }).state.doc.toString()).toBe(`${TOC}\n\n## A`);
    expect(state.update({ changes: { from: 0, to: TOC.length + 2 }, userEvent: 'delete.selection' }).state.doc.toString()).toBe('## A');
  });
});
