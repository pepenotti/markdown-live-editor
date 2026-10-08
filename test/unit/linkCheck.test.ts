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
import { tocBlock } from '../../src/shared/toc';
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

  it('lists the target of reference links once, where the definition writes it', () => {
    const text = '[full][Ref], [ref][] and [ref].\n\n[REF]: notes/a.md "Title"\n';
    const { links } = scanText(text);
    expect(links.map((l) => [l.kind, l.href, l.label])).toEqual([['definition', 'notes/a.md', undefined]]);
    expect(links[0].hrefFrom).toBe(text.indexOf('notes/a.md'));
    expect(text.slice(links[0].from, links[0].to)).toBe('notes/a.md');
  });

  it('does not take footnotes for links', () => {
    const text = 'A claim[^1] and another[^note], and [text][^1].\n\n# Title[^1]\n\n[^1]: The source, see [the paper](papers/a.pdf).\n[^note]: Plain.\n';
    const scan = scanText(text);
    expect(scan.links.map((l) => [l.kind, l.href])).toEqual([['link', 'papers/a.pdf']]);
    expect(scan.headings.map((h) => h.slug)).toEqual(['title']);
    expect(check(text)).toEqual([]);
  });

  it('does not take indexing such as matrix[i][j] for a reference link', () => {
    expect(scanText('Read matrix[i][j] and f(x)[0][1], then `a[i][j]`.\n').links).toEqual([]);
    expect(messages('But [i][j] on its own is one.\n')).toEqual(['No definition for [j]']);
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
    expect(headings.map((h) => h.slug)).toEqual(['set-up-now', 'setext-title', 'usage', 'usage-1', 'usage-2', 'snake_case-name', 'see-the-docs']);
    expect(headings[6].text).toBe('See [the docs](docs.md)');
    expect(text.slice(headings[3].from).startsWith('### Usage')).toBe(true);
  });

  it('collects id and name attributes of raw HTML as anchors', () => {
    const scan = scanText('<a name="top"></a>\n\nText <span id=\'inline\'>x</span> <a id=bare></a>\n\n<div id="block">\n</div>\n');
    expect(scan.htmlIds.sort()).toEqual(['bare', 'block', 'inline', 'top']);
    expect(hasAnchor(anchorSet(scan), 'top')).toBe(true);
    expect(check('<a id="Top"></a>\n\n[up](#Top) [bare](#bare)\n\n<a id=bare></a>\n')).toEqual([]);
  });

  it('reads the tree of the editor the same way as a fresh parse', () => {
    const text = '---\ntitle: x\n---\n\n# One[^n]\n\n[a](a.md) $[m](m.md)$ [r][x] ![i](i.png) note[^n] [t][^n]\n\n| [c](c.md) |\n| --- |\n\n```md\n[f](f.md)\n```\n\n[^n]: Note.\n\n[x]: x.md\n';
    const state = stateOf(text);
    const fromEditor = scanDocument(syntaxTree(state), text);
    expect(fromEditor).toEqual(scanText(text));
    expect(fromEditor.links.map((l) => l.href)).toEqual(['a.md', 'i.png', 'c.md', 'x.md']);
  });
});

describe('anchors', () => {
  const scan = scanText('# Getting Started\n\n## Setup\n\n## Setup\n\n## my_var\n');

  it('accepts slugs, numbered repeats and the written heading', () => {
    const anchors = anchorSet(scan);
    for (const ok of ['', 'getting-started', 'Getting-Started', 'Getting Started', 'setup', 'setup-1', 'my_var']) expect(hasAnchor(anchors, ok), ok).toBe(true);
    for (const bad of ['setup-2', 'started', 'set-up', 'myvar']) expect(hasAnchor(anchors, bad), bad).toBe(false);
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

  it('reports a bad reference target once, on its definition, however often it is used', () => {
    const text = 'Go to [the notes][n], [n] or ![pic][n].\n\n[n]: notes/a.md\n';
    const found = check(text, { 'notes/a.md': { reason: 'file' } });
    expect(found.map((f) => [text.slice(f.from, f.to), f.message])).toEqual([['notes/a.md', 'File not found: notes/a.md']]);
    // Without a definition there is nowhere else to say it, so each link is reported.
    expect(messages('[a][n] and [b][n]\n')).toEqual(['No definition for [n]', 'No definition for [n]']);
  });

  it('accepts every link of a generated table of contents', () => {
    const body = [
      '# Guide',
      '',
      '## Set up `npm` *now*, **really**',
      '## See [the docs](docs.md) and ~~old~~ [ref][r]',
      '## Notes[^1]',
      '## snake_case and _emphasis_',
      '## Café & Crème: 100%?',
      '## Usage',
      '> ## Usage',
      '',
      '- ## Usage',
      '',
      '## Usage',
      '### Usage ##',
      '',
      'Setext',
      '------',
      '',
      '[^1]: Note.',
      '',
      '[r]: https://example.com',
      '',
    ].join('\n');
    const toc = tocBlock(body);
    expect(toc.split('\n').length).toBeGreaterThan(8);
    expect(check(`${toc}\n\n${body}`)).toEqual([]);
    // Typed by hand with other capitals, or percent-encoded, they are still the same headings.
    expect(check(`[a](#Usage-1) [b](#caf%C3%A9--cr%C3%A8me-100) [c](#setext) [d](#notes)\n\n${body}`)).toEqual([]);
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
    expect(found).toHaveLength(2);
    expect(apply(text, found[0])).toBe('[a](notes/other.md#other-note "t") and [b][ref]\n\n[ref]: <notes/other.md#other-nte>\n');
    expect(apply(text, found[1])).toBe('[a](notes/other.md#other-nte "t") and [b][ref]\n\n[ref]: <notes/other.md#other-note>\n');
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
