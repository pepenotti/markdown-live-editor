import { syntaxTree } from '@codemirror/language';
import { describe, expect, it } from 'vitest';
import {
  analyse,
  anchorSet,
  checkAnchor,
  closestSlug,
  findHeading,
  type Finding,
  hasAnchor,
  lineStarts,
  type LinkIssue,
  positionIn,
  scanDocument,
  scanText,
  splitTarget,
  withIssues,
} from '../../src/shared/linkCheck';
import { stateOf } from './helpers';

/** Findings of a document when the "file system" answers with `missing`. */
function check(text: string, missing: Record<string, LinkIssue> = {}): Finding[] {
  const analysis = analyse(scanText(text));
  return withIssues(
    analysis,
    analysis.targets.map((t) => missing[t.anchor ? `${t.path}#${t.anchor}` : t.path] ?? null),
  );
}
const messages = (text: string, missing: Record<string, LinkIssue> = {}) => check(text, missing).map((f) => f.message);
const apply = (text: string, f: Finding) => text.slice(0, f.fix!.from) + f.fix!.insert + text.slice(f.fix!.to);

describe('splitTarget', () => {
  it('splits and decodes the path and the anchor', () => {
    expect(splitTarget('notes/a.md')).toEqual({ path: 'notes/a.md', anchor: '' });
    expect(splitTarget('other.md#set-up')).toEqual({ path: 'other.md', anchor: 'set-up' });
    expect(splitTarget('#heading')).toEqual({ path: '', anchor: 'heading' });
    expect(splitTarget('My%20notes/a%23b.md#caf%C3%A9')).toEqual({ path: 'My notes/a#b.md', anchor: 'café' });
    expect(splitTarget('/docs/a.md')).toEqual({ path: '/docs/a.md', anchor: '' });
    expect(splitTarget('img/p.png?raw=true')).toEqual({ path: 'img/p.png', anchor: '' });
  });

  it('leaves a malformed escape as it is', () => {
    expect(splitTarget('100%.md')).toEqual({ path: '100%.md', anchor: '' });
  });

  it('skips web links, other schemes, empty targets and templates', () => {
    for (const href of ['https://example.com/a.md', 'http://x', 'mailto:a@b.c', 'tel:123', 'vscode://x', 'data:image/png;base64,AA', '//cdn.example.com/x.png', '', '  ', '#', '{{ site.url }}/a.md', '${base}/a.md']) {
      expect(splitTarget(href), href).toBeNull();
    }
  });
});

describe('scanDocument', () => {
  it('finds inline links and images with the place the target is written', () => {
    const text = 'See [a](notes/a.md) and ![p](<img/my p.png> "title").\n';
    const { links } = scanText(text);
    expect(links.map((l) => [l.kind, l.href, text.slice(l.from, l.to)])).toEqual([
      ['link', 'notes/a.md', '[a](notes/a.md)'],
      ['image', 'img/my p.png', '![p](<img/my p.png> "title")'],
    ]);
    for (const l of links) expect(text.slice(l.hrefFrom, l.hrefFrom + l.href!.length)).toBe(l.href);
  });

  it('resolves reference links through their definition, in every form', () => {
    const text = '[full][Ref], [ref][] and [ref].\n\n[REF]: notes/a.md "Title"\n';
    const { links } = scanText(text);
    expect(links.map((l) => [l.kind, l.href, l.label])).toEqual([
      ['link', 'notes/a.md', 'Ref'],
      ['link', 'notes/a.md', 'ref'],
      ['link', 'notes/a.md', 'ref'],
      ['definition', 'notes/a.md', undefined],
    ]);
    // The target of a reference link is written in the definition.
    const at = text.indexOf('notes/a.md');
    expect(links.every((l) => l.hrefFrom === at)).toBe(true);
    expect(text.slice(links[3].from, links[3].to)).toBe('notes/a.md');
  });

  it('reports a reference without a definition, but not plain brackets', () => {
    const { links } = scanText('[text][nope] and ![pic][gone], but [just brackets], [ ] and [^1].\n\n> [!NOTE]\n> Text\n\n- [ ] task\n');
    expect(links.map((l) => [l.kind, l.href, l.label])).toEqual([
      ['link', null, 'nope'],
      ['image', null, 'gone'],
    ]);
  });

  it('finds an image inside a link', () => {
    expect(scanText('[![badge](img/b.svg)](docs/a.md)\n').links.map((l) => [l.kind, l.href])).toEqual([
      ['link', 'docs/a.md'],
      ['image', 'img/b.svg'],
    ]);
  });

  it('does not look inside code, math, front matter, comments or autolinks', () => {
    const text = [
      '---',
      'link: "[a](front.md)"',
      '---',
      '',
      '`[a](code.md)` and $[a](math.md)$ and <https://example.com> and https://example.com/bare',
      '',
      '```md',
      '[a](fenced.md)',
      '```',
      '',
      '    [a](indented.md)',
      '',
      '$$',
      '[a](block-math.md)',
      '$$',
      '',
      '<!-- [a](comment.md) -->',
      '',
      '| [a](cell.md) | b |',
      '| --- | --- |',
      '',
      '> - [a](quoted.md)',
    ].join('\n');
    expect(scanText(text).links.map((l) => l.href)).toEqual(['cell.md', 'quoted.md']);
  });

  it('gives headings GitHub-style slugs, numbering repeats', () => {
    const text = ['# Set up *now*!', '', 'Setext `title`', '===', '', '## Usage', '### Usage ##', '## Usage', '## snake_case name', '## See [the docs](docs.md)', '', '```', '# not a heading', '```', ''].join('\n');
    const { headings } = scanText(text);
    expect(headings.map((h) => h.slug)).toEqual(['set-up-now', 'setext-title', 'usage', 'usage-1', 'usage-2', 'snakecase-name', 'see-the-docs']);
    expect(headings[5].alt).toBe('snake_case-name');
    expect(headings[6].text).toBe('See [the docs](docs.md)');
    expect(text.slice(headings[3].from).startsWith('### Usage')).toBe(true);
  });

  it('collects id and name attributes of raw HTML as anchors', () => {
    const scan = scanText('<a name="top"></a>\n\nText <span id=\'inline\'>x</span>\n\n<div id="block">\n</div>\n');
    expect(scan.htmlIds.sort()).toEqual(['block', 'inline', 'top']);
    expect(hasAnchor(anchorSet(scan), 'top')).toBe(true);
  });

  it('reads the tree of the editor the same way as a fresh parse', () => {
    const text = '---\ntitle: x\n---\n\n# One\n\n[a](a.md) $[m](m.md)$ [r][x] ![i](i.png)\n\n| [c](c.md) |\n| --- |\n\n```md\n[f](f.md)\n```\n\n[x]: x.md\n';
    const state = stateOf(text);
    const fromEditor = scanDocument(syntaxTree(state), (from, to) => state.doc.sliceString(from, to));
    expect(fromEditor).toEqual(scanText(text));
    expect(fromEditor.links.map((l) => l.href)).toEqual(['a.md', 'x.md', 'i.png', 'c.md', 'x.md']);
  });
});

describe('anchors', () => {
  const scan = scanText('# Getting Started\n\n## Setup\n\n## Setup\n\n## my_var\n');

  it('accepts slugs, numbered repeats and the written heading', () => {
    const anchors = anchorSet(scan);
    for (const ok of ['', 'getting-started', 'Getting-Started', 'Getting Started', 'setup', 'setup-1', 'my_var', 'myvar']) expect(hasAnchor(anchors, ok), ok).toBe(true);
    for (const bad of ['setup-2', 'started', 'set-up']) expect(hasAnchor(anchors, bad), bad).toBe(false);
  });

  it('finds the heading an anchor points at', () => {
    expect(findHeading(scan.headings, 'setup-1')?.from).toBe(scan.headings[2].from);
    expect(findHeading(scan.headings, 'my_var')?.text).toBe('my_var');
    expect(findHeading(scan.headings, 'nope')).toBeUndefined();
  });

  it('suggests a close slug and nothing for a far one', () => {
    const slugs = ['getting-started', 'setup', 'installation', 'api'];
    expect(closestSlug('set-up', slugs)).toBe('setup');
    expect(closestSlug('Getting Startd', slugs)).toBe('getting-started');
    expect(closestSlug('install', slugs)).toBe('installation');
    expect(closestSlug('instalation', slugs)).toBe('installation');
    expect(closestSlug('licence', slugs)).toBeUndefined();
    expect(closestSlug('faq', slugs)).toBeUndefined();
    expect(closestSlug('', slugs)).toBeUndefined();
  });

  it('checks an anchor against another file', () => {
    expect(checkAnchor(scan, 'setup-1')).toBeNull();
    expect(checkAnchor(scan, 'setp')).toEqual({ reason: 'anchor', suggestion: 'setup' });
    expect(checkAnchor(scan, 'zzzzzz')).toEqual({ reason: 'anchor', suggestion: undefined });
  });
});

describe('findings', () => {
  it('asks about each file target once and never about web links', () => {
    const analysis = analyse(scanText('[a](a.md) [again](a.md) [b](a.md#x) ![i](/img/i.png) [w](https://example.com) [m](mailto:a@b.c) [h](#top)\n'));
    expect(analysis.targets).toEqual([
      { path: 'a.md', anchor: '' },
      { path: 'a.md', anchor: 'x' },
      { path: '/img/i.png', anchor: '' },
    ]);
    expect(analysis.pending.map((p) => p.target)).toEqual([0, 0, 1, 2]);
  });

  it('words the reasons', () => {
    const text = '# Title\n\n[a](notes/a.md) ![p](img/p.png) [s](other.md#setup) [h](#nope) [r][label] [ok](#title) [fine](here.md)\n';
    expect(messages(text, { 'notes/a.md': { reason: 'file' }, 'img/p.png': { reason: 'file' }, 'other.md#setup': { reason: 'anchor' } })).toEqual([
      'File not found: notes/a.md',
      'File not found: img/p.png',
      'No heading "setup" in other.md',
      'No heading "nope" in this document',
      'No definition for [label]',
    ]);
  });

  it('underlines the whole link, and the usage as well as the definition of a reference', () => {
    const text = 'Go to [the notes][n].\n\n[n]: notes/a.md\n';
    const found = check(text, { 'notes/a.md': { reason: 'file' } });
    expect(found.map((f) => text.slice(f.from, f.to))).toEqual(['[the notes][n]', 'notes/a.md']);
    expect(found.every((f) => f.message === 'File not found: notes/a.md' && f.reason === 'file')).toBe(true);
  });

  it('offers a close heading of the same document as a fix', () => {
    const text = '# Set up\n\nSee [how](#setup) and [where](<#set-pu>).\n';
    const found = check(text);
    expect(found.map((f) => f.message)).toEqual(['No heading "setup" in this document', 'No heading "set-pu" in this document']);
    expect(found[0].fix?.title).toBe('Change to "#set-up"');
    expect(apply(text, found[0])).toBe('# Set up\n\nSee [how](#set-up) and [where](<#set-pu>).\n');
    expect(apply(text, found[1])).toBe('# Set up\n\nSee [how](#setup) and [where](<#set-up>).\n');
  });

  it('fixes the anchor of another file, keeping the path, also inside a definition', () => {
    const text = '[a](notes/other.md#other-nte "t") and [b][ref]\n\n[ref]: <notes/other.md#other-nte>\n';
    const found = check(text, { 'notes/other.md#other-nte': { reason: 'anchor', suggestion: 'other-note' } });
    expect(found).toHaveLength(3);
    expect(apply(text, found[0])).toBe('[a](notes/other.md#other-note "t") and [b][ref]\n\n[ref]: <notes/other.md#other-nte>\n');
    // The reference link and its definition both fix the definition.
    const fixed = '[a](notes/other.md#other-nte "t") and [b][ref]\n\n[ref]: <notes/other.md#other-note>\n';
    expect(apply(text, found[1])).toBe(fixed);
    expect(apply(text, found[2])).toBe(fixed);
  });

  it('has no fix without a suggestion, for a missing file or for a missing definition', () => {
    const found = check('# A\n\n[x](#zzzzzzzz) [y](gone.md) [z][nope]\n', { 'gone.md': { reason: 'file' } });
    expect(found.map((f) => f.fix)).toEqual([undefined, undefined, undefined]);
  });

  it('finds nothing in a document without broken links', () => {
    expect(check('# A\n\n[a](#a) [b](b.md) <https://example.com> [c][d]\n\n[d]: d.md\n')).toEqual([]);
  });
});

describe('positions', () => {
  it('turns offsets into line and character', () => {
    const text = 'ab\n\ncdé\n';
    const starts = lineStarts(text);
    expect(starts).toEqual([0, 3, 4, 8]);
    expect([0, 2, 3, 4, 6, 7, 8].map((o) => positionIn(starts, o))).toEqual([
      { line: 0, ch: 0 },
      { line: 0, ch: 2 },
      { line: 1, ch: 0 },
      { line: 2, ch: 0 },
      { line: 2, ch: 2 },
      { line: 2, ch: 3 },
      { line: 3, ch: 0 },
    ]);
  });
});
