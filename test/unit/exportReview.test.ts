// Export: footnotes, alerts, anchors shared with the table of contents, and the rules that
// keep an exported file safe (what may be embedded, what may load, how the browser is run).
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { imageTarget, isInside, isLocalSource, looksLikeImage, normalizePath } from '../../src/shared/embed';
import { contentSecurityPolicy, localImageSources, renderDocument, renderMarkdown, stripFrontMatter } from '../../src/shared/exportHtml';
import { markdownParser } from '../../src/shared/markdownSyntax';
import { headingSlugs } from '../../src/shared/textUtil';
import { tocBlock } from '../../src/shared/toc';
import { footnotes } from '../../src/webview/links';
import { stateOf } from './helpers';

const html = (source: string, options = {}) => renderMarkdown(source, options).html;
const ids = (out: string) => [...out.matchAll(/ id="([^"]*)"/g)].map((m) => m[1]);

describe('footnotes in exported HTML', () => {
  const doc = [
    'Used first[^second], then[^1]. Again[^second], and [^missing] stays.',
    '',
    '[^1]: The first definition, with *emphasis* and a [link](https://example.com).',
    '[^second]: The second definition',
    'continues on the next line.',
    '[^unused]: Nothing points here.',
    '',
    'After.',
  ].join('\n');

  it('numbers notes by first reference and lists them at the end', () => {
    const out = html(doc);
    expect(out).toContain('Used first<sup class="footnote-ref"><a href="#fn-1" id="fnref-1">1</a></sup>, then<sup class="footnote-ref"><a href="#fn-2" id="fnref-2">2</a></sup>.');
    expect(out).toContain('Again<sup class="footnote-ref"><a href="#fn-1" id="fnref-1-2">1</a></sup>, and [^missing] stays.');
    expect(out).toContain('<p>After.</p>\n<section class="footnotes">\n<ol>\n<li id="fn-1">The second definition\ncontinues on the next line. <a href="#fnref-1"');
    expect(out).toContain('<li id="fn-2">The first definition, with <em>emphasis</em> and a <a href="https://example.com">link</a>. <a href="#fnref-2"');
    expect(out).not.toContain('Nothing points here');
    expect(out).not.toContain('[^1]');
    // Every link between a reference and its note resolves.
    for (const m of out.matchAll(/href="#(fn[^"]*)"/g)) expect(ids(out), m[1]).toContain(m[1]);
  });

  it('numbers them like the editor does', () => {
    const docs = [
      doc,
      'a[^b] c[^a] d[^b]\n\n[^a]: A\n[^b]: B',
      'Case[^Note] folds[^NOTE].\n\n[^note]: one',
      '`[^a]` in code, real[^a].\n\n```\n[^b]: not a note\n```\n\n[^a]: A',
      'x[^a]\n\n> quoted[^q]\n\n- item[^i]\n\n[^i]: I\n[^q]: Q\n[^a]: A',
      'no notes here [^x]',
      'para[^1]\n[^1]: ends the paragraph',
      '| a[^t] |\n| - |\n| b[^u] |\n\n[^u]: U\n[^t]: T',
    ];
    for (const text of docs) {
      const numbered = new Map<string, number>();
      for (const m of html(text).matchAll(/<a href="#fn-(\d+)" id="fnref-\d+(?:-\d+)?">\d+<\/a>/g)) numbered.set(m[1], Number(m[1]));
      expect(numbered.size, text).toBe(footnotes(stateOf(text)).numbers.size);
      // The text of note n in the export is the text of the definition the editor gives number n.
      const notes = [...html(text).matchAll(/<li id="fn-(\d+)">([\s\S]*?) <a href="#fnref/g)].map((m) => [Number(m[1]), m[2].replace(/<[^>]+>/g, '')]);
      const state = stateOf(text);
      const expected = [...footnotes(state).numbers].map(([id, n]) => {
        const from = footnotes(state).definitions.get(id)!;
        return [n, state.doc.sliceString(from, state.doc.lineAt(from).to).trim().replace(/[*`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')];
      });
      expect(notes.map(([n, t]) => [n, String(t).split('\n')[0]]), text).toEqual(expected);
    }
  });

  it('leaves documents without footnotes alone and finds images in notes', () => {
    expect(html('A [^x] and [text][^y].')).toBe('<p>A [^x] and [text][^y].</p>\n');
    expect(localImageSources('x[^a]\n\n[^a]: ![i](notes/img.png)')).toEqual(['notes/img.png']);
    expect(html('x[^a]\n\n[^a]: ![i](notes/img.png)', { images: new Map([['notes/img.png', 'data:x']]) })).toContain('<img src="data:x" alt="i">');
  });
});

describe('alerts in exported HTML', () => {
  it('turns the five GitHub alerts into callouts', () => {
    for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
      const title = kind[0].toUpperCase() + kind.slice(1);
      expect(html(`> [!${kind.toUpperCase()}]\n> Text *here*.`)).toBe(
        `<blockquote class="alert alert-${kind}">\n<p><strong class="alert-title">${title}</strong><br>\nText <em>here</em>.</p>\n</blockquote>\n`,
      );
    }
    expect(html('> [!note]\n>\n> Later paragraph.')).toContain('<p><strong class="alert-title">Note</strong></p>\n<p>Later paragraph.</p>');
    expect(renderDocument('> [!TIP]\n> x').html).toContain('.alert-tip{');
  });

  it('leaves other quotes as they are', () => {
    expect(html('> [!NOTE] same line')).toBe('<blockquote>\n<p>[!NOTE] same line</p>\n</blockquote>\n');
    expect(html('> [!SOMETHING]\n> x')).not.toContain('alert');
    expect(html('> text\n> [!NOTE]')).not.toContain('alert');
    expect(html('[!NOTE]\ntext')).toBe('<p>[!NOTE]\ntext</p>\n');
  });
});

describe('front matter and math in quotes', () => {
  it('treats front matter that never closes like the editor: it runs to the end', () => {
    const text = '---\ntitle: x\n\n# Not a heading\n';
    expect(stripFrontMatter(text)).toBe('');
    expect(html(text)).toBe('');
    const tree = markdownParser.parse(text);
    expect(tree.topNode.firstChild?.name).toBe('FrontMatter');
    expect(tree.topNode.firstChild?.to).toBeGreaterThanOrEqual(text.trimEnd().length);
    expect(stripFrontMatter('---')).toBe('---');
  });

  it('renders $$ blocks inside quotes and lists without the markers', () => {
    const quoted = html('> $$\n> \\frac{a}{b}\n> $$\n>\n> after $x$');
    expect(quoted).toMatch(/^<blockquote>\n<div class="math-block"><span class="katex"><math [^>]*display="block"/);
    expect(quoted).toContain('<mfrac><mi>a</mi><mi>b</mi></mfrac>');
    expect(quoted).not.toContain('&gt;');
    expect(quoted).toContain('<p>after <span class="katex">');
    const listed = html('- item\n\n  $$\n  c = d\n  $$\n\n- next');
    expect(listed).toContain('<div class="math-block">');
    expect(listed).toContain('<annotation encoding="application/x-tex">c = d</annotation>');
    // A block that is not closed ends with the quote, not with the document.
    expect(html('> $$\n> a\n\nafter')).toContain('<p>after</p>');
  });
});

describe('heading anchors', () => {
  it('keeps counting when a numbered slug is already taken', () => {
    expect(headingSlugs([{ text: 'a' }, { text: 'a-1' }, { text: 'a' }, { text: 'a' }])).toEqual(['a', 'a-1', 'a-2', 'a-3']);
    expect(headingSlugs([{ text: 'Setup' }, { text: 'Setup' }, { text: 'Other' }, { text: 'Setup' }])).toEqual(['setup', 'setup-1', 'other', 'setup-2']);
  });

  it('gives every link of a generated table of contents a target', () => {
    const body = [
      '# Guide',
      '',
      '<!-- toc -->',
      '<!-- tocstop -->',
      '',
      '## Setup',
      '### Install `npm` & *more*',
      '## Setup',
      '## [Linked](https://example.com) title[^n]',
      '## snake_case and Ünï côdé',
      '## Setup-1',
      '',
      'Underlined',
      '----------',
      '',
      '> ## Setup',
      '',
      '```',
      '## not a heading',
      '```',
      '## Setup',
      '',
      '[^n]: note',
    ].join('\n');
    for (const text of [body, `---\ntitle: T\ntags: [a]\n---\n\n${body}`, body.replace(/\n/g, '\r\n')]) {
      const toc = tocBlock(text);
      const withToc = text.replace(/<!-- toc -->\r?\n<!-- tocstop -->/, toc);
      const out = html(withToc);
      const links = [...out.matchAll(/<li><a href="#([^"]+)">/g)].map((m) => decodeURIComponent(m[1]));
      expect(links.length).toBe(7);
      expect(new Set(ids(out)).size).toBe(ids(out).length);
      for (const link of links) expect(ids(out), link).toContain(link);
      // The link text is the text of the heading it points at.
      for (const m of out.matchAll(/<li><a href="#([^"]+)">(.*?)<\/a>/g)) {
        const target = new RegExp(`<h\\d id="${decodeURIComponent(m[1]).replace(/[-\\]/g, '\\$&')}">(.*?)</h\\d>`).exec(out);
        expect(target?.[1].replace(/<sup.*?<\/sup>|<[^>]+>/g, ''), m[1]).toBe(m[2].replace(/<[^>]+>/g, ''));
      }
      expect(out).toContain('<!-- toc -->');
      expect(out).toContain('<h2 id="underlined">Underlined</h2>');
    }
  });
});

describe('what an exported file may load', () => {
  const hostile = [
    '# Doc',
    '<script>document.title = "ran"</script>',
    '<script src="https://evil.example/x.js"></script>',
    '<iframe src="https://evil.example/"></iframe>',
    '<link rel="stylesheet" href="https://evil.example/x.css">',
    '<a href="javascript:alert(1)">x</a> <img src="x" onerror="alert(1)">',
    '',
    '```mermaid\nflowchart LR\n  A --> B\n```',
  ].join('\n');

  it('allows no script at all by default', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain(`default-src 'none'`);
    expect(csp).not.toContain('script-src');
    expect(csp).not.toMatch(/https?:/);
    const { html: doc } = renderDocument(hostile);
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${csp}">`);
    // The policy comes before anything from the document.
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<title>'));
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('evil.example'));
  });
});

describe('which images may be embedded', () => {
  const doc = '/home/me/project/docs';
  const project = '/home/me/project';
  const roots = [doc, project];
  const target = (src: string, r = roots, p: string | null = project) => imageTarget(src, doc, p, r);

  it('reads image files in the document folder and the project', () => {
    expect(target('assets/a.png')).toEqual({ path: '/home/me/project/docs/assets/a.png', mime: 'image/png' });
    expect(target('./a%20b.JPG?v=2#x')).toEqual({ path: '/home/me/project/docs/a b.JPG', mime: 'image/jpeg' });
    expect(target('../images/a.svg')).toEqual({ path: '/home/me/project/images/a.svg', mime: 'image/svg+xml' });
    expect(target('/images/a.gif')).toEqual({ path: '/home/me/project/images/a.gif', mime: 'image/gif' });
  });

  it('never reads a file that is not named as an image', () => {
    for (const src of ['../../.ssh/id_rsa', 'notes/other.md', '.env', '/etc/passwd', 'secret.txt', 'a.png/../../../../etc/shadow', 'key.pem?x=.png', 'key.pem#.png']) {
      expect(target(src), src).toEqual({ skip: 'not an image' });
    }
  });

  it('never reads an image outside the document folder and the project', () => {
    const outside = { skip: 'outside the document folder and the project' };
    for (const src of ['../../Pictures/private.png', '../../../../etc/logo.png', '..%2F..%2Fother/a.png', '/../outside.png', '../../project-two/a.png', '../../../../../../../../a.png']) {
      expect(target(src), src).toEqual(outside);
    }
    // Without a workspace only the folder of the document counts.
    expect(target('../images/a.svg', [doc], null)).toEqual(outside);
    expect(target('/images/a.gif', [doc], null)).toEqual({ skip: 'no project folder' });
    expect(target('sub/../a.png', [doc], null)).toEqual({ path: '/home/me/project/docs/a.png', mime: 'image/png' });
    // Windows paths differ in the case of the drive letter only.
    expect(imageTarget('a.png', '/c:/Users/me/docs', null, ['/C:/Users/me/docs'], true)).toEqual({ path: '/c:/Users/me/docs/a.png', mime: 'image/png' });
    expect(imageTarget('a.png', '/c:/Users/me/docs', null, ['/C:/Users/me/docs'])).toEqual(outside);
  });

  it('knows paths and URLs apart', () => {
    expect(normalizePath('/a/b/../c/./d//e')).toBe('/a/c/d/e');
    expect(normalizePath('/a/../..')).toBeNull();
    expect(isInside('/a/b', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b', '/a/bc/d')).toBe(false);
    for (const src of ['file:///etc/passwd.png', '\\\\server\\share\\a.png', '//server/a.png', 'C:\\Users\\me\\a.png', 'vscode-resource:/a.png']) expect(isLocalSource(src), src).toBe(false);
  });

  it('checks that the bytes are the image the name promises', () => {
    const bytes = (...parts: (string | number[])[]) => Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...new TextEncoder().encode(p)] : p)));
    expect(looksLikeImage(bytes([0x89], 'PNG\r\n', [0x1a], '\n', [0, 0, 0, 13], 'IHDR'), 'image/png')).toBe(true);
    expect(looksLikeImage(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF'), 'image/jpeg')).toBe(true);
    expect(looksLikeImage(bytes('GIF89a....'), 'image/gif')).toBe(true);
    expect(looksLikeImage(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '), 'image/webp')).toBe(true);
    expect(looksLikeImage(bytes([0, 0, 0, 28], 'ftypavif', [0, 0, 0, 0]), 'image/avif')).toBe(true);
    expect(looksLikeImage(bytes('BM', [1, 2, 3, 4]), 'image/bmp')).toBe(true);
    expect(looksLikeImage(bytes([0, 0, 1, 0, 1, 0]), 'image/x-icon')).toBe(true);
    expect(looksLikeImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml')).toBe(true);
    expect(looksLikeImage(bytes([0xef, 0xbb, 0xbf], '<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg>\n<svg>'), 'image/svg+xml')).toBe(true);
    // A private key, a text file or a web page called .png or .svg is not embedded.
    const secret = bytes('-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n');
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/x-icon', 'image/svg+xml', 'text/plain']) {
      expect(looksLikeImage(secret, mime), mime).toBe(false);
      expect(looksLikeImage(new Uint8Array(0), mime), mime).toBe(false);
    }
    expect(looksLikeImage(bytes('<html><svg></svg></html>'), 'image/svg+xml')).toBe(false);
    expect(looksLikeImage(bytes('GIF89a....'), 'image/png')).toBe(false);
  });
});

describe('Copy as HTML', () => {
  it('is byte for byte what markdown-it gives for Markdown without the new constructs', () => {
    const plain = new MarkdownIt({ html: true, linkify: true });
    const docs = [
      'First line\n\nSecond paragraph with a word.\n',
      'Some *emphasis*, **strong**, ~~struck~~, `code`, a [link](https://example.com "t") and <https://auto.example>.\nSoft break  \nhard break.',
      '- one\n- two\n  - nested\n\n1. first\n2. second\n\n* [link only](x.md)\n',
      '| a | b |\n| :- | -: |\n| 1 | 2 |\n',
      '```\nplain <code> & "quotes"\n```\n\n    indented code\n\n~~~text\nfenced with a language nobody colours\n~~~\n',
      '> quote\n> more\n>\n> > nested\n\n---\n\n***\n',
      '<div align="center">\n  <img src="a.png" width="10">\n</div>\n\nInline <kbd>Ctrl</kbd> and <br> tags &amp; entities &copy; \\* escapes.\n',
      '![alt](assets/a.png "title") and ![ref][r] and [text][r]\n\n[r]: https://example.com/r.png "R"\n',
      'Prices: $5 and $10, 100% sure, a_b_c, 2 * 3 * 4, www.example.com and me@example.com.\n',
      'Line one\r\nLine two\r\n\r\nTabs\tand trailing spaces   \n',
      '[x] not a task, [^nonote] no note, [!NOTE] no alert, #no heading, 1) list?\n',
      '<!-- a comment -->\n\ntext\n',
    ];
    for (const doc of docs) expect(html(doc), doc).toBe(plain.render(doc));
  });
});
