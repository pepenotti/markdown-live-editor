// What the wiki link feature must never do: change anything while it is turned off,
// take a file name from document text on trust, or resolve a name to a file elsewhere.
import { CompletionContext } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/shared/exportHtml';
import { analyse, type Finding, type LinkIssue, scanText, withIssues } from '../../src/shared/linkCheck';
import { markdownParser, wikiMarkdownParser } from '../../src/shared/markdownSyntax';
import type { Mode } from '../../src/shared/protocol';
import { MAX_LINKS_PER_NOTE, newNoteFileName, NoteSet, scanNote } from '../../src/shared/wikiLinks';
import { blockField } from '../../src/webview/decorations/blocks';
import { collectInline, lineAtoms } from '../../src/webview/decorations/inline';
import { popoverField } from '../../src/webview/linkPopover';
import { modeField } from '../../src/webview/modes';
import { wikiSource } from '../../src/webview/ui/completions';
import { stateOf } from './helpers';

const SAMPLE = [
  '# Title',
  '',
  'See [[Note]], [[Note#Part|shown]], [[folder/Other]] and [[#Title]].',
  'A [link](other.md), a [ref] and matrix[[1]] and ![[embed]].',
  '',
  '`[[code]]` and $[[x]]$ and a note[^1] in [[^1]].',
  '',
  '| a | b |',
  '| - | - |',
  '| [[Cell]] | x |',
  '',
  '[^1]: Footnote with [[Note]].',
  '',
].join('\n');

const editor = (doc: string, mode: Mode, wikiLinks: boolean): EditorState => stateOf(doc, [modeField.init(() => mode), blockField, popoverField], { wikiLinks });

function check(text: string, wikiLinks: boolean, answers: Record<string, LinkIssue> = {}): Finding[] {
  const analysis = analyse(scanText(text, wikiLinks));
  return withIssues(
    analysis,
    analysis.targets.map((t) => answers[`${t.wiki ? 'wiki:' : ''}${t.path}${t.anchor ? '#' + t.anchor : ''}`] ?? null),
  );
}

describe('with wiki links turned off, nothing changes', () => {
  it('parses every document exactly like the parser without the extension', () => {
    expect(String(syntaxTree(stateOf(SAMPLE)))).toBe(String(markdownParser.parse(SAMPLE)));
    expect(String(syntaxTree(stateOf(SAMPLE, [], { wikiLinks: false })))).toBe(String(markdownParser.parse(SAMPLE)));
    expect(String(markdownParser.parse(SAMPLE))).not.toContain('WikiLink');
    // The default parser object is not touched by building the one with wiki links.
    expect(String(wikiMarkdownParser().parse(SAMPLE))).toContain('WikiLink');
    expect(String(markdownParser.parse(SAMPLE))).not.toContain('WikiLink');
  });

  it('draws the same decorations and atoms whether the option is false or absent', () => {
    for (const mode of ['raw', 'half', 'full'] as const) {
      const plain = stateOf(SAMPLE, [modeField.init(() => mode), blockField]);
      const off = editor(SAMPLE, mode, false);
      const shape = (state: EditorState) =>
        collectInline(state, [{ from: 0, to: state.doc.length }]).decorations.map((d) => `${d.from}-${d.to}:${String(d.value.spec.class ?? d.value.spec.widget?.constructor.name ?? 'hide')}`);
      expect(shape(off)).toEqual(shape(plain));
      expect(shape(off).join(' ')).not.toContain('wikilink');
      expect(lineAtoms(off, 30)).toEqual(lineAtoms(plain, 30));
    }
  });

  it('reports the same links as before, and no wiki link', () => {
    const scan = scanText(SAMPLE);
    expect(scan).toEqual(scanText(SAMPLE, false));
    expect(scan.links.some((l) => l.kind === 'wiki')).toBe(false);
    // What the checker says about double brackets on main: nothing, and a missing definition next to them is still found.
    expect(check('See [[Note]] and [text][nolabel].\n', false).map((f) => f.message)).toEqual(['No definition for [nolabel]']);
    expect(check(SAMPLE, false)).toEqual(check(SAMPLE, false, { 'wiki:Note': { reason: 'note' } }));
    expect(analyse(scan).targets.every((t) => !t.wiki)).toBe(true);
  });

  it('exports double brackets as the text they are', () => {
    expect(renderMarkdown('See [[Note|x]] and [[#Title]].').html).toBe('<p>See [[Note|x]] and [[#Title]].</p>\n');
    expect(renderMarkdown(SAMPLE).html).toBe(renderMarkdown(SAMPLE, { wikiLinks: undefined }).html);
  });

  it('offers no completion and asks the host nothing', async () => {
    let asked = 0;
    const host = { request: async () => (asked++, { notes: [{ name: 'Note', path: 'Note.md' }], headings: [] }) as never };
    const state = stateOf('See [[No¦');
    const context = new CompletionContext(state, state.selection.main.head, false);
    expect(await wikiSource(host, () => false)(context)).toBeNull();
    expect(asked).toBe(0);
    const on = stateOf('See [[No¦', [], { wikiLinks: true });
    const result = await wikiSource(host, () => true)(new CompletionContext(on, on.selection.main.head, false));
    expect(result?.options.map((o) => o.label)).toEqual(['Note']);
    expect(asked).toBe(1);
  });

  it('shows no popover for double brackets in full preview', () => {
    expect(editor('a [[No¦te]] b', 'full', false).field(popoverField)).toBeNull();
    expect(editor('a [[No¦te]] b', 'full', true).field(popoverField)).toMatchObject({ pos: 2, end: 10 });
  });
});

describe('link checking with wiki links turned on', () => {
  it('finds wiki links instead of reference links without a definition', () => {
    const scan = scanText(SAMPLE, true);
    expect(scan.links.filter((l) => l.kind === 'wiki').map((l) => l.href)).toEqual(['Note', 'Note#Part', 'folder/Other', '#Title', '1', 'Cell', 'Note']);
    // Not in code or math, not the footnote in brackets, not an image. Nothing is wrong until the host says so.
    expect(check(SAMPLE, true).map((f) => f.message)).toEqual(check(SAMPLE, false).map((f) => f.message));
    expect(check('See [[Note]] and [text][nolabel].\n', true).map((f) => f.message)).toEqual(['No definition for [nolabel]']);
    expect(check('[[Note]]', true, { 'wiki:Note': { reason: 'note' } }).map((f) => f.message)).toEqual(['No note called "Note"']);
  });

  it('asks the host about each note once, marked as a note name', () => {
    const analysis = analyse(scanText('[[Note]] [[Note|again]] [[Note#Part]] [x](Note) [[#Here]]\n\n# Here\n', true));
    expect(analysis.targets).toEqual([
      { path: 'Note', anchor: '', wiki: true },
      { path: 'Note', anchor: 'Part', wiki: true },
      { path: 'Note', anchor: '' },
    ]);
    expect(analysis.local).toEqual([]);
  });

  it('reports a missing note, an ambiguous name and a missing heading through the same findings', () => {
    const text = 'A [[Gone]] b [[Twice|x]] c [[Note#Instalation]] d [[Note#Part]] e [[#Nowhere]]\n';
    const findings = check(text, true, {
      'wiki:Gone': { reason: 'note' },
      'wiki:Twice': { reason: 'ambiguous' },
      'wiki:Note#Instalation': { reason: 'anchor', suggestion: 'installation' },
    });
    expect(findings.map((f) => [text.slice(f.from, f.to), f.reason, f.message])).toEqual([
      ['[[Gone]]', 'note', 'No note called "Gone"'],
      ['[[Twice|x]]', 'ambiguous', 'Several notes are called "Twice"'],
      ['[[Note#Instalation]]', 'anchor', 'No heading "Instalation" in Note'],
      ['[[#Nowhere]]', 'anchor', 'No heading "Nowhere" in this document'],
    ]);
    const fix = findings[2].fix!;
    expect(text.slice(0, fix.from) + fix.insert + text.slice(fix.to)).toContain('[[Note#installation]] d');
  });

  it('keeps the heading fix inside the brackets when there is shown text', () => {
    const text = '[[Note#Instalation|read this]]';
    const fix = check(text, true, { 'wiki:Note#Instalation': { reason: 'anchor', suggestion: 'installation' } })[0].fix!;
    expect(text.slice(0, fix.from) + fix.insert + text.slice(fix.to)).toBe('[[Note#installation|read this]]');
  });
});

describe('export with wiki links turned on', () => {
  const hrefs: Record<string, string> = { Note: 'Note.html', 'folder/Other': 'folder/Other.html', 'My Note': 'My%20Note.html' };
  const html = (source: string) => renderMarkdown(source, { wikiLinks: (target) => hrefs[target] ?? null }).html;

  it('links a note to its exported file and keeps the shown text', () => {
    expect(html('See [[Note]].')).toBe('<p>See <a href="Note.html" class="wikilink">Note</a>.</p>\n');
    expect(html('[[Note#Second part|part two]]')).toBe('<p><a href="Note.html#second-part" class="wikilink">part two</a></p>\n');
    expect(html('[[folder/Other]] [[My Note]]')).toContain('<a href="My%20Note.html" class="wikilink">My Note</a>');
    expect(html('# Top\n\n[[#Top]]')).toContain('<a href="#top" class="wikilink">#Top</a>');
  });

  it('exports a note that is missing or ambiguous as its text', () => {
    expect(html('See [[Gone]] and [[Gone|that]].')).toBe('<p>See Gone and that.</p>\n');
  });

  it('escapes what comes from the document', () => {
    expect(html('[[Gone|<b>x</b> & "y"]]')).toBe('<p>&lt;b&gt;x&lt;/b&gt; &amp; &quot;y&quot;</p>\n');
    expect(renderMarkdown('[[A"b]]', { wikiLinks: () => 'x"y.html' }).html).toBe('<p><a href="x&quot;y.html" class="wikilink">A&quot;b</a></p>\n');
  });

  it('leaves code, footnotes in brackets and unfinished brackets alone', () => {
    expect(html('`[[Note]]`')).toBe('<p><code>[[Note]]</code></p>\n');
    expect(html('    [[Note]]')).toContain('<code>[[Note]]');
    expect(html('[[Note] and [[]]')).toBe('<p>[[Note] and [[]]</p>\n');
    expect(html('a[^1] [[^1]]\n\n[^1]: note')).not.toContain('wikilink');
  });
});

describe('creating a note from a link', () => {
  it('accepts a plain name and adds the extension', () => {
    expect(newNoteFileName('Meeting notes')).toBe('Meeting notes.md');
    expect(newNoteFileName('  Idea (v2) – draft  ')).toBe('Idea (v2) – draft.md');
    expect(newNoteFileName('Plan.markdown')).toBe('Plan.markdown');
    expect(newNoteFileName('año 2026')).toBe('año 2026.md');
  });

  it('refuses anything that is not one plain file name', () => {
    const refused = [
      '',
      '   ',
      '.',
      '..',
      '../Escape',
      '..\\Escape',
      'folder/Note',
      'folder\\Note',
      '/etc/passwd',
      '/Note',
      'C:\\Users\\x',
      'C:Note',
      '~/Note/x',
      '.hidden',
      '.config',
      'Note.',
      'a\u0000b',
      'a\nb',
      'a\tb',
      'a\u007fb',
      'a\u202eb',
      'a<b',
      'a>b',
      'a"b',
      'a|b',
      'a?b',
      'a*b',
      'CON',
      'con',
      'nul.md',
      'COM1',
      'lpt9.txt',
      'Aux.markdown',
      'x'.repeat(201),
    ];
    for (const name of refused) expect([name, newNoteFileName(name)]).toEqual([name, null]);
    // Names that merely start like a reserved one are fine.
    expect(newNoteFileName('Console')).toBe('Console.md');
    expect(newNoteFileName('com10')).toBe('com10.md');
  });
});

describe('a name never resolves outside the folders a note belongs to', () => {
  const notes = new NoteSet();
  for (const p of ['/ws/a/Note.md', '/ws/a/sub/Deep.md', '/other/Secret.md', '/other/Note.md', '/ws-two/Twin.md', '/etc/passwd.md']) notes.add(p);

  it('ignores notes of other folders, by name and by path', () => {
    expect(notes.resolve('Secret', '/ws/a/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(notes.resolve('../../other/Secret', '/ws/a/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(notes.resolve('../../../etc/passwd', '/ws/a/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(notes.resolve('/other/Secret', '/ws/a/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(notes.resolve('/etc/passwd.md', '/ws/a/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    // The note of the same name elsewhere does not make this one ambiguous.
    expect(notes.resolve('Note', '/ws/Home.md', ['/ws'])).toEqual({ status: 'found', path: '/ws/a/Note.md' });
    // A folder whose name merely starts with the root's is another folder.
    expect(notes.resolve('Twin', '/ws/Home.md', ['/ws'])).toEqual({ status: 'missing' });
    expect(notes.resolve('../ws-two/Twin', '/ws/Home.md', ['/ws'])).toEqual({ status: 'missing' });
  });

  it('a note outside the workspace sees its own folder only', () => {
    expect(notes.resolve('Note', '/other/Secret.md', ['/other'])).toEqual({ status: 'found', path: '/other/Note.md' });
    expect(notes.resolve('Deep', '/other/Secret.md', ['/other'])).toEqual({ status: 'missing' });
  });

  it('with several workspace folders, every one of them counts', () => {
    expect(notes.resolve('Twin', '/ws/Home.md', ['/ws', '/ws-two'])).toEqual({ status: 'found', path: '/ws-two/Twin.md' });
    expect(notes.resolve('/Twin', '/ws/Home.md', ['/ws', '/ws-two'])).toEqual({ status: 'found', path: '/ws-two/Twin.md' });
    // A file at the top of another folder does not beat a namesake: the name is ambiguous, as it would be anywhere else.
    const two = new NoteSet();
    for (const p of ['/ws/x/Twin.md', '/ws-two/Twin.md', '/ws/Top.md', '/ws-two/Top.md']) two.add(p);
    expect(two.resolve('Twin', '/ws/Home.md', ['/ws', '/ws-two'])).toEqual({ status: 'ambiguous', paths: ['/ws-two/Twin.md', '/ws/x/Twin.md'] });
    expect(two.resolve('Twin', '/ws-two/Home.md', ['/ws-two', '/ws'])).toEqual({ status: 'found', path: '/ws-two/Twin.md' });
    expect(two.resolve('Top', '/ws/deep/Home.md', ['/ws', '/ws-two'])).toEqual({ status: 'found', path: '/ws/Top.md' });
  });

  it('lists candidate paths only inside the roots', () => {
    expect(NoteSet.exactPaths('sub/Deep', '/ws/a/Home.md', ['/ws'])).toEqual([
      '/ws/a/sub/Deep.md',
      '/ws/a/sub/Deep.markdown',
      '/ws/a/sub/Deep.mdown',
      '/ws/a/sub/Deep.mkd',
      '/ws/sub/Deep.md',
      '/ws/sub/Deep.markdown',
      '/ws/sub/Deep.mdown',
      '/ws/sub/Deep.mkd',
    ]);
    expect(NoteSet.exactPaths('../../x.md', '/ws/a/Home.md', ['/ws'])).toEqual([]);
    expect(NoteSet.exactPaths('../b/x.md', '/ws/a/Home.md', ['/ws'])).toEqual(['/ws/b/x.md']);
    expect([...notes.within(['/ws'])]).toEqual(['/ws/a/Note.md', '/ws/a/sub/Deep.md']);
  });

  it('forgets the notes of a deleted folder', () => {
    const set = new NoteSet();
    for (const p of ['/ws/a/One.md', '/ws/a/b/Two.md', '/ws/ab/Three.md']) set.add(p);
    expect(set.deleteFolder('/ws/a')).toBe(2);
    expect([...set.all()]).toEqual(['/ws/ab/Three.md']);
    expect(set.resolve('Two', '/ws/x.md', ['/ws'])).toEqual({ status: 'missing' });
  });
});

describe('bounds', () => {
  it('keeps a limited number of links per file', () => {
    const note = scanNote(Array.from({ length: MAX_LINKS_PER_NOTE + 500 }, (_, i) => `[[Note ${i}]]`).join('\n'));
    expect(note.links.length).toBe(MAX_LINKS_PER_NOTE);
    expect(note.lines.size).toBe(MAX_LINKS_PER_NOTE);
  });

  it('does not take a footnote in brackets for a link', () => {
    expect(scanNote('a [[^1]] b [[Note]]').links).toEqual([{ line: 0, kind: 'wiki', target: 'Note' }]);
  });
});

describe('wiki links next to the other hidden syntax of full preview', () => {
  it('keeps its own popover apart from links, math and images', () => {
    const doc = 'a [[Note]] b [link](u) c $x$ d';
    const at = (pos: number) => stateOf(doc, [modeField.init(() => 'full'), blockField, popoverField], { wikiLinks: true }).update({ selection: { anchor: pos } }).state.field(popoverField);
    const wiki = at(5);
    const link = at(15);
    const math = at(26);
    expect(wiki).toMatchObject({ pos: 2, end: 10 });
    expect(link).toMatchObject({ pos: 13, end: 22 });
    expect(math).toMatchObject({ pos: 25, end: 28 });
    expect(wiki!.create).not.toBe(link!.create);
    expect(link!.create).toBe(math!.create);
    // Outside the visible text of the wiki link there is none.
    expect(at(1)).toBeNull();
  });

  it('has atoms that do not overlap those of a footnote or a list marker', () => {
    const state = stateOf('- [[Note|x]][^1] end\n\n[^1]: text [[Other]]', [modeField.init(() => 'full'), blockField], { wikiLinks: true });
    const atoms = lineAtoms(state, 0);
    expect(atoms).toEqual([
      { from: 0, to: 2, kind: 'leading' },
      { from: 2, to: 9, kind: 'inline' },
      { from: 10, to: 12, kind: 'inline' },
      { from: 12, to: 16, kind: 'inline' },
    ]);
    const last = state.doc.line(3);
    const inNote = lineAtoms(state, last.from).map((a) => state.doc.sliceString(a.from, a.to));
    expect(inNote).toEqual(['[^1]: ', '[[', ']]']);
  });
});
