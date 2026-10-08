import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import type { Mode } from '../../src/shared/protocol';
import { formatWikiLink, joinPath, linkLeadsTo, mayLeadTo, NoteSet, parseWikiLink, scanNote } from '../../src/shared/wikiLinks';
import { blockField } from '../../src/webview/decorations/blocks';
import { collectInline, lineAtoms } from '../../src/webview/decorations/inline';
import { editGuard } from '../../src/webview/guard';
import { modeField } from '../../src/webview/modes';
import { wikiLinkAt, wikiLinkInfo } from '../../src/webview/wikiLinks';
import { stateOf } from './helpers';

function nodes(doc: string, wikiLinks = true): string[] {
  const state = stateOf(doc, [], { wikiLinks });
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (/^(WikiLink|Link|InlineCode|Emphasis)$/.test(n.name)) out.push(`${n.name}:${state.doc.sliceString(n.from, n.to)}`);
    },
  });
  return out;
}

const editor = (doc: string, mode: Mode, wikiLinks = true): EditorState =>
  stateOf(doc, [modeField.init(() => mode), blockField, editGuard], { wikiLinks });

/** The document as it is drawn: hidden ranges removed. */
function visible(state: EditorState): string {
  const hidden: { from: number; to: number }[] = [];
  for (const d of collectInline(state, [{ from: 0, to: state.doc.length }]).decorations) {
    if (d.value.spec.class === undefined && d.value.spec.widget === undefined && d.to > d.from) hidden.push({ from: d.from, to: d.to });
  }
  let out = '';
  let pos = 0;
  for (const h of hidden.sort((a, b) => a.from - b.from)) {
    out += state.doc.sliceString(pos, h.from);
    pos = Math.max(pos, h.to);
  }
  return out + state.doc.sliceString(pos);
}

function classesAt(state: EditorState, text: string): string[] {
  const at = state.doc.toString().indexOf(text);
  return collectInline(state, [{ from: 0, to: state.doc.length }])
    .decorations.filter((d) => d.from <= at && d.to >= at + text.length && typeof d.value.spec.class === 'string')
    .flatMap((d) => (d.value.spec.class as string).split(' '));
}

describe('wiki link syntax', () => {
  it('parses the four forms', () => {
    expect(nodes('See [[Note]] and [[Note|shown text]].')).toEqual(['WikiLink:[[Note]]', 'WikiLink:[[Note|shown text]]']);
    expect(nodes('[[Note#Heading]] [[folder/Note]] [[#Here]]')).toEqual(['WikiLink:[[Note#Heading]]', 'WikiLink:[[folder/Note]]', 'WikiLink:[[#Here]]']);
    expect(nodes('*in [[Note]] emphasis*')).toEqual(['Emphasis:*in [[Note]] emphasis*', 'WikiLink:[[Note]]']);
  });

  it('is not a link inside code, when escaped, empty or unfinished', () => {
    expect(nodes('`[[Note]]` in code')).toEqual(['InlineCode:`[[Note]]`']);
    expect(nodes('```\n[[Note]]\n```')).toEqual([]);
    expect(nodes('    [[Note]] indented code')).toEqual([]);
    expect(nodes('\\[[Note]]').filter((n) => n.startsWith('Wiki'))).toEqual([]);
    expect(nodes('[[]] and [[  ]] and [[Note] and [[a\nb]]').filter((n) => n.startsWith('Wiki'))).toEqual([]);
  });

  it('leaves ordinary links alone', () => {
    expect(nodes('[text](url) and [[text](url)]')).toEqual(['Link:[text](url)', 'Link:[text](url)']);
  });

  it('is plain text while the setting is off', () => {
    // The stock parser sees possible reference links, which are drawn only when a definition exists.
    expect(nodes('See [[Note]] and [[Note|x]].', false)).toEqual(['Link:[Note]', 'Link:[Note|x]']);
    const off = editor('See [[Note]] here', 'full', false);
    expect(visible(off)).toBe('See [[Note]] here');
    expect(lineAtoms(off, 0)).toEqual([]);
  });

  it('splits a link into target, heading and shown text', () => {
    expect(parseWikiLink('Note')).toEqual({ target: 'Note', heading: '', alias: '' });
    expect(parseWikiLink(' folder/Note # A heading | shown | text ')).toEqual({ target: 'folder/Note', heading: 'A heading', alias: 'shown | text' });
    expect(parseWikiLink('#Here')).toEqual({ target: '', heading: 'Here', alias: '' });
    expect(parseWikiLink('Note|C# notes')).toEqual({ target: 'Note', heading: '', alias: 'C# notes' });
  });

  it('writes a link back without characters that would break it', () => {
    expect(formatWikiLink({ target: 'Note', heading: '', alias: '' })).toBe('[[Note]]');
    expect(formatWikiLink({ target: 'a/Note', heading: 'Part 2', alias: 'see here' })).toBe('[[a/Note#Part 2|see here]]');
    expect(formatWikiLink({ target: 'No]]te', heading: '', alias: 'x [y]\nz' })).toBe('[[No  te|x  y  z]]');
  });
});

describe('wiki link rendering', () => {
  it('shows the shown text, or the note name, in both preview modes', () => {
    for (const mode of ['half', 'full'] as const) {
      expect(visible(editor('See [[Note]] and [[Note#Part|the part]] and [[Other|]].\n\nend¦', mode))).toBe('See Note and the part and Other.\n\nend');
    }
    expect(visible(editor('See [[Note|x]]¦', 'raw'))).toBe('See [[Note|x]]');
  });

  it('reveals the source under the cursor in half preview only', () => {
    expect(visible(editor('See [[No¦te|x]] and [[Other]]', 'half'))).toBe('See [[Note|x]] and Other');
    expect(visible(editor('See [[No¦te|x]] and [[Other]]', 'full'))).toBe('See x and Other');
  });

  it('hides the brackets and the target as inline atoms in full preview', () => {
    const state = editor('a [[Note|x]] b [[Other]]', 'full');
    expect(lineAtoms(state, 0)).toEqual([
      { from: 2, to: 9, kind: 'inline' },
      { from: 10, to: 12, kind: 'inline' },
      { from: 15, to: 17, kind: 'inline' },
      { from: 22, to: 24, kind: 'inline' },
    ]);
    expect(lineAtoms(editor('a [[Note|x]]', 'half'), 0)).toEqual([]);
  });

  it('finds the link and its visible range at a position', () => {
    const state = editor('a [[Note#H|x]] b', 'full');
    expect(wikiLinkAt(state, 0)).toBeNull();
    expect(wikiLinkAt(state, 5)).toMatchObject({ target: 'Note', heading: 'H', alias: 'x', from: 2, to: 14, shownFrom: 11, shownTo: 12 });
    expect(wikiLinkInfo(state.doc, 2, 14)).toMatchObject({ shownFrom: 11, shownTo: 12 });
    expect(wikiLinkAt(editor('a [[Note]] b', 'full', false), 5)).toBeNull();
  });

  it('styles it as a link', () => {
    expect(classesAt(editor('a [[Note]] b', 'half'), 'Note')).toEqual(['cm-md-link', 'cm-md-wikilink']);
  });

  it('removes the whole link when its visible text is deleted in full preview', () => {
    const state = editor('a [[Note|x]] b', 'full');
    expect(state.update({ changes: { from: 9, to: 10 }, userEvent: 'delete.backward' }).state.doc.toString()).toBe('a  b');
  });
});

describe('note resolution', () => {
  const notes = new NoteSet();
  for (const p of ['/ws/Home.md', '/ws/projects/Plan.md', '/ws/projects/Ideas.md', '/ws/archive/Plan.md', '/ws/archive/old/Log.markdown', '/ws/journal/Log.md', '/ws/journal/Today.md']) {
    notes.add(p);
  }
  const from = (path: string, name: string) => notes.resolve(name, path, ['/ws']);

  it('takes an exact relative path first', () => {
    expect(from('/ws/Home.md', 'projects/Plan')).toEqual({ status: 'found', path: '/ws/projects/Plan.md' });
    expect(from('/ws/Home.md', 'projects/Plan.md')).toEqual({ status: 'found', path: '/ws/projects/Plan.md' });
    expect(from('/ws/projects/Ideas.md', '../archive/Plan')).toEqual({ status: 'found', path: '/ws/archive/Plan.md' });
    expect(from('/ws/journal/Today.md', '/archive/Plan')).toEqual({ status: 'found', path: '/ws/archive/Plan.md' });
    // Relative to the root of the workspace from anywhere.
    expect(from('/ws/journal/Today.md', 'archive/old/Log')).toEqual({ status: 'found', path: '/ws/archive/old/Log.markdown' });
  });

  it('finds a unique name anywhere, without case or extension', () => {
    expect(from('/ws/journal/Today.md', 'ideas')).toEqual({ status: 'found', path: '/ws/projects/Ideas.md' });
    expect(from('/ws/journal/Today.md', 'HOME.md')).toEqual({ status: 'found', path: '/ws/Home.md' });
    expect(from('/ws/Home.md', 'Projects/ideas')).toEqual({ status: 'found', path: '/ws/projects/Ideas.md' });
    expect(from('/ws/Home.md', 'old/log')).toEqual({ status: 'found', path: '/ws/archive/old/Log.markdown' });
  });

  it('prefers the note in the same folder when a name is taken twice', () => {
    expect(from('/ws/projects/Ideas.md', 'plan')).toEqual({ status: 'found', path: '/ws/projects/Plan.md' });
    expect(from('/ws/archive/Plan.md', 'Plan')).toEqual({ status: 'found', path: '/ws/archive/Plan.md' });
    expect(from('/ws/journal/Today.md', 'log')).toEqual({ status: 'found', path: '/ws/journal/Log.md' });
  });

  it('reports a name it cannot settle as ambiguous, and an unknown one as missing', () => {
    expect(from('/ws/Home.md', 'Plan')).toEqual({ status: 'ambiguous', paths: ['/ws/archive/Plan.md', '/ws/projects/Plan.md'] });
    expect(from('/ws/Home.md', 'Log.md')).toEqual({ status: 'found', path: '/ws/journal/Log.md' });
    expect(from('/ws/Home.md', 'Nowhere')).toEqual({ status: 'missing' });
    expect(from('/ws/Home.md', 'missing/Plan')).toEqual({ status: 'missing' });
    expect(from('/ws/Home.md', '  ')).toEqual({ status: 'missing' });
    expect(from('/ws/Home.md', '../../etc/passwd')).toEqual({ status: 'missing' });
  });

  it('follows files being added and removed', () => {
    const set = new NoteSet();
    expect(set.add('/ws/a/Note.md')).toBe(true);
    expect(set.add('/ws/a/Note.md')).toBe(false);
    set.add('/ws/b/Note.md');
    expect(set.resolve('Note', '/ws/x.md', ['/ws']).status).toBe('ambiguous');
    expect(set.delete('/ws/b/Note.md')).toBe(true);
    expect(set.resolve('Note', '/ws/x.md', ['/ws'])).toEqual({ status: 'found', path: '/ws/a/Note.md' });
    set.delete('/ws/a/Note.md');
    expect(set.resolve('Note', '/ws/x.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(set.size).toBe(0);
  });

  it('names a note by its file name, or by its path when the name is shared', () => {
    expect(notes.nameOf('/ws/projects/Ideas.md', '/ws')).toBe('Ideas');
    expect(notes.nameOf('/ws/projects/Plan.md', '/ws')).toBe('projects/Plan');
    expect(from('/ws/Home.md', notes.nameOf('/ws/archive/Plan.md', '/ws'))).toEqual({ status: 'found', path: '/ws/archive/Plan.md' });
  });

  it('joins paths', () => {
    expect(joinPath('/a/b', '../c/./d.md')).toBe('/a/c/d.md');
    expect(joinPath('/a', '../../x')).toBe('/x');
  });
});

describe('links of a note', () => {
  const text = [
    '---',
    'title: "[[Front]]"',
    '---',
    '# Title *here*',
    'A [[Plan]] and [[Ideas#Next|ideas]] on one line.',
    'A [link](../archive/Plan.md#part) and <https://example.com/x.md>.',
    'An ![image](pic.png), a [site](https://example.com/a.md) and an [anchor](#title).',
    '`[[Code]]` and [spaced](<My%20Note.md>)',
    '```',
    '[[Fenced]] [x](fenced.md)',
    '```',
    '[ref]: notes/Ref.markdown "title"',
    '## Second',
    '[[#Title]]',
  ].join('\n');

  it('finds wiki links and relative Markdown links, with their lines', () => {
    const note = scanNote(text);
    expect(note.links).toEqual([
      { line: 4, kind: 'wiki', target: 'Plan' },
      { line: 4, kind: 'wiki', target: 'Ideas' },
      { line: 5, kind: 'path', target: '../archive/Plan.md' },
      { line: 7, kind: 'path', target: 'My Note.md' },
      { line: 11, kind: 'path', target: 'notes/Ref.markdown' },
    ]);
    expect(note.lines.get(4)).toBe('A [[Plan]] and [[Ideas#Next|ideas]] on one line.');
    expect([...note.lines.keys()]).toEqual([4, 5, 7, 11]);
    expect(note.headings).toEqual(['Title here', 'Second']);
  });

  it('handles CRLF text', () => {
    expect(scanNote('a\r\n[[Note]]\r\n').links).toEqual([{ line: 1, kind: 'wiki', target: 'Note' }]);
  });

  it('tells which links lead to a note', () => {
    const notes = new NoteSet();
    for (const p of ['/ws/Home.md', '/ws/projects/Plan.md', '/ws/archive/Plan.md', '/ws/projects/Ideas.md']) notes.add(p);
    const leads = (kind: 'wiki' | 'path', target: string, fromPath: string, to: string) => {
      const link = { line: 0, kind, target };
      return mayLeadTo(link, to) && linkLeadsTo(link, fromPath, to, notes, ['/ws']);
    };
    expect(leads('wiki', 'Ideas', '/ws/Home.md', '/ws/projects/Ideas.md')).toBe(true);
    expect(leads('wiki', 'projects/plan', '/ws/Home.md', '/ws/projects/Plan.md')).toBe(true);
    // Ambiguous from the root, settled by the folder from inside it.
    expect(leads('wiki', 'Plan', '/ws/Home.md', '/ws/projects/Plan.md')).toBe(false);
    expect(leads('wiki', 'Plan', '/ws/projects/Ideas.md', '/ws/projects/Plan.md')).toBe(true);
    expect(leads('wiki', 'Plan', '/ws/projects/Ideas.md', '/ws/archive/Plan.md')).toBe(false);
    expect(leads('path', '../archive/Plan.md', '/ws/projects/Ideas.md', '/ws/archive/Plan.md')).toBe(true);
    expect(leads('path', 'Plan.md', '/ws/projects/Ideas.md', '/ws/archive/Plan.md')).toBe(false);
    expect(leads('path', '/projects/Ideas.md', '/ws/archive/Plan.md', '/ws/projects/Ideas.md')).toBe(true);
    expect(leads('path', 'projects/Ideas.md', '/ws/Home.md', '/ws/projects/Ideas.md')).toBe(true);
  });
});
