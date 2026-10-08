import { readFileSync } from 'node:fs';
import { syntaxTree } from '@codemirror/language';
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { browserCandidates, isCompletePdf, printToPdfArgs } from '../../src/shared/browsers';
import {
  imageMime,
  isLocalSource,
  localImageSources,
  MERMAID_CDN_MAJOR,
  MERMAID_CDN_URL,
  renderDocument,
  renderMarkdown,
  sourceToPath,
  stripFrontMatter,
} from '../../src/shared/exportHtml';
import { highlight } from '../../src/shared/highlight';
import { mathPlugin } from '../../src/shared/mathPlugin';
import { stateOf } from './helpers';

const html = (source: string, options = {}) => renderMarkdown(source, options).html;

/** Math found by the markdown-it plugin, as `kind:tex`. */
function exported(doc: string): string[] {
  const out: string[] = [];
  const md = new MarkdownIt();
  mathPlugin(md, (tex, display) => {
    out.push(`${display ? 'display' : 'inline'}:${tex}`);
    return '';
  });
  md.render(doc);
  return out;
}

/** Math found by the editor's parser, in the same notation. */
function edited(doc: string): string[] {
  const state = stateOf(doc);
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter(n) {
      if (!/Math$/.test(n.name)) return;
      const text = state.doc.sliceString(n.from, n.to);
      const width = text.startsWith('$$') ? 2 : 1;
      const tex = text.slice(width, text.endsWith('$'.repeat(width)) && text.length >= width * 2 ? -width : undefined).trim();
      out.push(`${n.name === 'BlockMath' || width === 2 ? 'display' : 'inline'}:${tex}`);
    },
  });
  return out;
}

describe('math in exported HTML', () => {
  it('finds inline and block math', () => {
    expect(exported('Euler: $e^{i\\pi}+1=0$ done')).toEqual(['inline:e^{i\\pi}+1=0']);
    expect(exported('display $$x^2$$ inline')).toEqual(['display:x^2']);
    expect(exported('$$\nx = 1\n$$\n\nafter')).toEqual(['display:x = 1']);
    expect(exported('$$ x = 1 $$')).toEqual(['display:x = 1']);
    expect(exported('$a*b*c$ and *em*')).toEqual(['inline:a*b*c']);
  });

  it('leaves prices and stray dollar signs alone', () => {
    for (const doc of ['It costs $5 or $10 today', 'a $ b $ c', 'escaped \\$x$ here', '`$x$` in code', '$', 'x $$ y']) {
      expect(exported(doc), doc).toEqual([]);
    }
    expect(html('It costs $5 or $10 today')).toBe('<p>It costs $5 or $10 today</p>\n');
  });

  it('agrees with the editor about what is math', () => {
    const docs = [
      'Euler: $e^{i\\pi}+1=0$ done',
      'display $$x^2$$ inline',
      'It costs $5 or $10 today',
      'a $ b $ c',
      'escaped \\$x$ here',
      '`$x$` in code',
      'two $a$ and $b$ here, $5 and $c$',
      'ends in digit $x$2 and $y$ z',
      'escaped inside $a\\$b$ end',
      '$a*b*c$ and *em*',
      '$$\nx = 1\n$$\n\nafter',
      '$$ x = 1 $$',
      '$$\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n$$',
      'text\n\n$$\nnever closed\n\nmore',
      '- item\n\n  $$\n  y\n  $$\n\n- next $z$',
      '| a | b |\n| - | - |\n| $x$ | $5 |',
      '```\n$$\nx\n$$\n```',
      '    $$\n    x\n    $$',
      'para\n$$\nx\n$$',
      '# Title with $h$',
      '$$a$$ b $$c$$',
      '$$',
      '$$$$',
    ];
    for (const doc of docs) expect(exported(doc), doc).toEqual(edited(doc));
    // Inside a quote the export drops the quote markers from the TeX.
    expect(exported('> $$\n> q = 1\n> $$\n\nout')).toEqual(['display:q = 1']);
  });

  it('renders MathML that needs no style sheet or fonts', () => {
    const inline = html('Sum $a^2$.');
    expect(inline).toMatch(/^<p>Sum <span class="katex"><math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML">/);
    expect(inline).not.toContain('katex-html');
    const block = html('$$\n\\frac{1}{2}\n$$');
    expect(block).toMatch(/^<div class="math-block"><span class="katex"><math [^>]*display="block"/);
    expect(block).toContain('<mfrac>');
  });

  it('shows a TeX error in place instead of failing', () => {
    expect(html('$\\frac{$')).toContain('katex-error');
  });
});

describe('exported HTML', () => {
  it('keeps plain Markdown as markdown-it renders it', () => {
    expect(html('First line\n\nSecond paragraph with a word.\n')).toBe('<p>First line</p>\n<p>Second paragraph with a word.</p>\n');
    expect(html('<details open>\n<summary>S</summary>\n</details>\n')).toBe('<details open>\n<summary>S</summary>\n</details>\n');
    expect(html('see https://example.com/x')).toContain('<a href="https://example.com/x">');
  });

  it('gives headings GitHub-style ids and numbers the repeats', () => {
    const out = html('# Hello, World!\n\n## Setup\n\n## Setup\n\n### Setup\n\n## `code` and *em* & more\n\n## Ünï côdé\n\n## !!!');
    expect(out).toContain('<h1 id="hello-world">Hello, World!</h1>');
    expect(out.match(/id="[^"]*"/g)).toEqual(['id="hello-world"', 'id="setup"', 'id="setup-1"', 'id="setup-2"', 'id="code-and-em--more"', 'id="ünï-côdé"']);
    expect(out).toContain('<h2>!!!</h2>');
  });

  it('does not let a numbered id collide with a real one', () => {
    expect(html('# a\n\n# a-1\n\n# a').match(/id="[^"]*"/g)).toEqual(['id="a"', 'id="a-1"', 'id="a-2"']);
  });

  it('takes the title from the first heading', () => {
    expect(renderMarkdown('intro\n\n## The *real* `title`\n\n# Later').title).toBe('The real title');
    expect(renderMarkdown('no headings').title).toBe('');
    const doc = renderDocument('text', { fallbackTitle: 'notes <1>' }).html;
    expect(doc).toContain('<title>notes &lt;1&gt;</title>');
    expect(renderDocument('# A & B').html).toContain('<title>A &amp; B</title>');
  });

  it('strips front matter', () => {
    expect(stripFrontMatter('---\ntitle: x\n---\n# A')).toBe('# A');
    expect(stripFrontMatter('---\r\ntitle: x\r\n...\r\nbody')).toBe('body');
    expect(stripFrontMatter('---\n---\nbody')).toBe('body');
    // A rule followed by text, and a block that never closes, are not front matter.
    expect(stripFrontMatter('---\n\ntext\n\n---\n')).toBe('---\n\ntext\n\n---\n');
    expect(stripFrontMatter('---\ntitle: x\nbody')).toBe('---\ntitle: x\nbody');
    expect(stripFrontMatter('a\n---\nb: c\n---\n')).toBe('a\n---\nb: c\n---\n');
    expect(renderMarkdown('---\ntitle: Hidden\n---\n\n# Shown\n')).toMatchObject({ html: '<h1 id="shown">Shown</h1>\n', title: 'Shown' });
  });

  it('turns task list items into checkboxes', () => {
    const out = html('- [ ] open\n- [x] done with `code`\n  - [X] nested\n- plain\n\n1. [ ] numbered\n\n[ ] not a list\n\n- [ ]');
    expect(out).toContain('<ul class="contains-task-list">\n<li class="task-list-item"><input type="checkbox" disabled> open</li>');
    expect(out).toContain('<li class="task-list-item"><input type="checkbox" disabled checked> done with <code>code</code>');
    expect(out).toContain('<li class="task-list-item"><input type="checkbox" disabled checked> nested</li>');
    expect(out).toContain('<li>plain</li>');
    expect(out).toContain('<ol class="contains-task-list">');
    expect(out).toContain('<p>[ ] not a list</p>');
    expect(out).toContain('<li>[ ]</li>');
    expect(out.match(/contains-task-list/g)).toHaveLength(3);
  });

  it('colours code in known languages and escapes the rest', () => {
    const js = html('```js\nconst a = "<b>";\n```');
    expect(js).toContain('<pre><code class="language-js"><span class="tok-keyword">const</span>');
    expect(js).toContain('<span class="tok-string">&quot;&lt;b&gt;&quot;</span>');
    expect(js).not.toContain('<b>');
    expect(html('```unknownlang\n<b> & "q"\n```')).toBe('<pre><code class="language-unknownlang">&lt;b&gt; &amp; &quot;q&quot;\n</code></pre>\n');
    expect(html('```\n<i>\n```')).toBe('<pre><code>&lt;i&gt;\n</code></pre>\n');
  });

  it('highlights every language without losing text', () => {
    const text = (s: string | null) => s?.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const samples: Record<string, string> = {
      ts: 'interface A<T> { x: T }\nconst f = (a: number): string => `${a}`;\n',
      tsx: 'const App = () => <div className="a">{x && <b/>}</div>;\n',
      json: '{ "a": [1, true, null], "b": "c" }\n',
      python: 'def f(x):\n    """doc"""\n    return x + 1  # note\n',
      css: 'a:hover { color: #fff; margin: 0 auto }\n',
      html: '<p class="x">a &amp; b</p>\n<!-- c -->\n',
      xml: '<?xml version="1.0"?>\n<a b="c">d</a>\n',
      yaml: 'key: value\nlist:\n  - 1\n  - "two"\n',
      rust: 'fn main() { let x: u32 = 1; println!("{}", x); }\n',
      go: 'package main\n\nfunc main() { fmt.Println("x") }\n',
      java: 'class A { public static void main(String[] a) { int x = 1; } }\n',
      cpp: '#include <vector>\nint main() { std::vector<int> v; return 0; }\n',
    };
    for (const [language, code] of Object.entries(samples)) {
      const out = highlight(code, language);
      expect(text(out), language).toBe(code);
      expect(out, language).toContain('<span class="tok-');
    }
    expect(highlight('x', 'constructor')).toBeNull();
    expect(highlight('x', 'sh')).toBeNull();
  });

  it('leaves a Mermaid block as code unless diagrams were asked for', () => {
    const source = '```mermaid\nflowchart LR\n  A --> B\n```\n';
    const plain = renderDocument(source);
    expect(plain.hasMermaid).toBe(true);
    expect(plain.html).toContain('<pre><code class="language-mermaid">flowchart LR\n  A --&gt; B\n</code></pre>');
    expect(plain.html).not.toContain('<script');
    expect(plain.html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);

    const drawn = renderDocument(source, { mermaid: true });
    expect(drawn.html).toContain('<pre class="mermaid">flowchart LR\n  A --&gt; B\n</pre>');
    expect(drawn.html).toContain(`import mermaid from '${MERMAID_CDN_URL}';`);
    // No script when there is nothing to draw.
    expect(renderDocument('# No diagrams', { mermaid: true }).html).not.toContain('<script');
  });

  it('loads the Mermaid version the editor bundles', () => {
    const installed = JSON.parse(readFileSync(new URL('../../node_modules/mermaid/package.json', import.meta.url), 'utf8')).version as string;
    expect(Number(installed.split('.')[0])).toBe(MERMAID_CDN_MAJOR);
  });

  it('lists local images and swaps in their replacements', () => {
    const source = [
      '![a](assets/one.png) ![b](<assets/two shots.png> "t") ![c](https://example.com/x.png) ![d](data:image/png;base64,AAAA)',
      '',
      '![again](assets/one.png) [![linked](../up.svg?v=2#frag)](https://example.com)',
      '',
      '<img src="raw/block.gif" width="10">',
      '',
      "Text <img alt='x' src='raw/inline.jpg'> and <img src=\"//cdn.example.com/y.png\">.",
      '',
      '```\n![code](not/an/image.png)\n```',
    ].join('\n');
    expect(localImageSources(source)).toEqual(['assets/one.png', 'assets/two%20shots.png', '../up.svg?v=2#frag', 'raw/block.gif', 'raw/inline.jpg']);

    const images = new Map(localImageSources(source).map((src, i) => [src, `data:x;base64,${i}`]));
    const out = html(source, { images });
    expect(out.match(/src="[^"]*"/g)).toEqual([
      'src="data:x;base64,0"',
      'src="data:x;base64,1"',
      'src="https://example.com/x.png"',
      'src="data:image/png;base64,AAAA"',
      'src="data:x;base64,0"',
      'src="data:x;base64,2"',
      'src="data:x;base64,3"',
      'src="data:x;base64,4"',
      'src="//cdn.example.com/y.png"',
    ]);
    // Without replacements the relative paths stay.
    expect(html('![a](assets/one.png)')).toBe('<p><img src="assets/one.png" alt="a"></p>\n');
  });

  it('maps image sources to files', () => {
    expect(isLocalSource('a/b.png')).toBe(true);
    expect(isLocalSource('/root.png')).toBe(true);
    for (const src of ['https://x/y.png', 'data:image/png;base64,AA', '//x/y.png', 'file:///x.png', '#frag', ' ']) expect(isLocalSource(src), src).toBe(false);
    expect(sourceToPath('assets/two%20shots.png?v=1#x')).toBe('assets/two shots.png');
    expect(sourceToPath('bad%zz.png')).toBe('bad%zz.png');
    expect(imageMime('a/B.PNG')).toBe('image/png');
    expect(imageMime('a.svg')).toBe('image/svg+xml');
    expect(imageMime('a.jpeg')).toBe('image/jpeg');
    expect(imageMime('a.txt')).toBeUndefined();
    expect(imageMime('constructor')).toBeUndefined();
  });

  it('builds a complete document with embedded styles', () => {
    const { html: doc } = renderDocument('# Title\n\ntext');
    expect(doc.startsWith('<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">')).toBe(true);
    expect(doc).toContain('<title>Title</title>');
    expect(doc).toContain('<main class="markdown-body">\n<h1 id="title">Title</h1>\n<p>text</p>\n</main>');
    expect(doc).toContain('@media (prefers-color-scheme:dark)');
    expect(doc).not.toMatch(/<link\b|<script\b|@import|url\(/);
    expect(doc.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('has a print version with page rules and no dark colours', () => {
    const { html: doc } = renderDocument('# Title', { print: true });
    expect(doc).not.toContain('prefers-color-scheme');
    expect(doc).toContain('@page{margin:');
    expect(doc).toContain('break-after:avoid');
    expect(doc).toContain('break-inside:avoid');
  });
});

describe('finding a browser for PDF', () => {
  it('tells a finished PDF from a partial one', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    expect(isCompletePdf(bytes('%PDF-1.4\n1 0 obj\nendobj\ntrailer\nstartxref\n9\n%%EOF\n'))).toBe(true);
    expect(isCompletePdf(bytes('%PDF-1.4\n1 0 obj\nendobj\n'))).toBe(false);
    expect(isCompletePdf(bytes('<html>not a pdf %%EOF</html>'))).toBe(false);
    expect(isCompletePdf(new Uint8Array(0))).toBe(false);
  });

  it('knows the usual places on each platform', () => {
    expect(browserCandidates('darwin', {}, '/Users/me')[0]).toBe('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(browserCandidates('darwin', {}, '/Users/me')).toContain('/Users/me/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    expect(browserCandidates('linux', {}, '/home/me')).toContain('/usr/bin/chromium');
    const windows = browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)\\' }, 'C:\\Users\\me');
    expect(windows[0]).toBe('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
    expect(windows).toContain('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    expect(browserCandidates('win32', {}, 'C:\\Users\\me')).toEqual([]);
  });

  it('prints headless, without a header, into the given file', () => {
    const args = printToPdfArgs('file:///tmp/a.html', '/tmp/a b.pdf', '/tmp/profile', false);
    expect(args).toEqual(expect.arrayContaining(['--headless', '--no-pdf-header-footer', '--print-to-pdf=/tmp/a b.pdf', '--user-data-dir=/tmp/profile']));
    expect(args.at(-1)).toBe('file:///tmp/a.html');
    expect(args.some((a) => a.startsWith('--virtual-time-budget'))).toBe(false);
    expect(printToPdfArgs('file:///tmp/a.html', '/tmp/a.pdf', '/tmp/p', true).some((a) => a.startsWith('--virtual-time-budget'))).toBe(true);
  });
});
