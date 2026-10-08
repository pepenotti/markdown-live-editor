// "Email Document…": the HTML that is put on the clipboard and the link that opens the mail app.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderEmail, renderMarkdown } from '../../src/shared/exportHtml';
import { isSafeMailto, mailtoLink, MAX_LINK, MAX_SUBJECT, oneLine, PASTE_HINT, recipients } from '../../src/shared/mailto';

const html = (source: string) => renderEmail(source).html;
/** The fields of a link as a mail app reads them. */
function parse(link: string) {
  const [, to, query] = /^mailto:([^?]*)\?(.*)$/.exec(link)!;
  const fields = query.split('&').map((pair) => pair.split('=').map(decodeURIComponent));
  return { to: decodeURIComponent(to), names: fields.map(([name]) => name), ...Object.fromEntries(fields) } as { to: string; names: string[]; subject: string; body: string };
}

describe('the mailto link', () => {
  it('carries the subject and a note to paste, and nothing of the document', () => {
    const link = mailtoLink('Quarterly report');
    expect(link).toBe('mailto:?subject=Quarterly%20report&body=%28Paste%20here%29');
    expect(parse(link)).toMatchObject({ to: '', names: ['subject', 'body'], subject: 'Quarterly report', body: PASTE_HINT });
    expect(isSafeMailto(link)).toBe(true);
  });

  it('cannot be given another recipient, header or attachment by a title', () => {
    const titles = [
      'Hi&bcc=evil@example.com',
      'Hi?cc=evil@example.com&attach=/etc/passwd',
      'Hi&attachment=~/.ssh/id_rsa',
      'Line one\r\nBcc: evil@example.com',
      'Line one\nbcc:evil@example.com\n\nbody text',
      'Hi%0D%0ABcc:%20evil@example.com',
      'Hi%26bcc%3Devil@example.com',
      'a#fragment&to=evil@example.com',
      'mailto:evil@example.com?subject=x',
      'Hi\u2028Bcc: evil@example.com',
      '"><script>alert(1)</script>',
      'Hi\u0000\u0007&body=replaced',
    ];
    for (const title of titles) {
      const link = mailtoLink(title, 'me@example.com');
      expect(isSafeMailto(link), title).toBe(true);
      // One line, two fields, one recipient: everything else is part of the subject text.
      expect(link, title).not.toMatch(/[\r\n\s]/);
      expect(link.match(/[?&]/g), title).toEqual(['?', '&']);
      const parsed = parse(link);
      expect(parsed.names, title).toEqual(['subject', 'body']);
      expect(parsed.to, title).toBe('me@example.com');
      expect(parsed.body, title).toBe(PASTE_HINT);
      expect(parsed.subject, title).not.toMatch(/[\r\n\u2028\u0000-\u001f]/);
    }
    // The text of the title is kept as text, and what looks like an escape stays what it was.
    expect(parse(mailtoLink('Q&A: 100% sure? #1 = yes')).subject).toBe('Q&A: 100% sure? #1 = yes');
    expect(parse(mailtoLink('Hi%0D%0ABcc: x@y.z')).subject).toBe('Hi%0D%0ABcc: x@y.z');
    expect(parse(mailtoLink('Line one\r\nBcc: evil@example.com')).subject).toBe('Line one Bcc: evil@example.com');
  });

  it('cuts a very long title and stays far below what mail apps accept', () => {
    const long = mailtoLink('word '.repeat(5000));
    expect(parse(long).subject).toHaveLength(MAX_SUBJECT);
    expect(parse(long).subject.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(300);
    // Letters that take nine characters each once encoded.
    const wide = mailtoLink('漢'.repeat(500), 'me@example.com');
    expect(wide.length).toBeLessThanOrEqual(MAX_LINK);
    expect(parse(wide).subject).toMatch(/^漢+…$/);
    expect(isSafeMailto(wide)).toBe(true);
    const emoji = mailtoLink('👩‍👩‍👧‍👦'.repeat(200));
    expect(emoji.length).toBeLessThanOrEqual(MAX_LINK);
    expect(() => decodeURIComponent(emoji)).not.toThrow();
    expect(oneLine('  a \n\t b  ', 10)).toBe('a b');
    expect(oneLine('abcdef', 4)).toBe('abc…');
    expect(parse(mailtoLink('')).subject).toBe('');
  });

  it('takes plain addresses from the setting and nothing else', () => {
    expect(recipients('a@example.com, b.c+tag@sub.example.org; d@x.io')).toEqual(['a@example.com', 'b.c+tag@sub.example.org', 'd@x.io']);
    expect(mailtoLink('S', 'a@example.com, b@example.com')).toBe('mailto:a@example.com,b@example.com?subject=S&body=%28Paste%20here%29');
    const hostile = [
      'a@example.com?bcc=evil@example.com',
      'a@example.com&cc=evil@example.com',
      'a@example.com%0ABcc:evil@example.com',
      'a@example.com\nBcc: evil@example.com',
      'Name <a@example.com>',
      'not an address',
      'a@b@c.com',
      '@example.com',
      'a@',
      'a@exa mple.com',
      'a@example.com/../../x',
      'javascript:alert(1)',
      '',
    ];
    for (const value of hostile) expect(recipients(value), JSON.stringify(value)).toEqual([]);
    expect(mailtoLink('S', hostile.join(','))).toBe('mailto:?subject=S&body=%28Paste%20here%29');
    // A good address next to bad ones is kept; a very long list is cut so the link stays short.
    expect(recipients('bad one, ok@example.com, x?y@z.com')).toEqual(['ok@example.com']);
    const many = mailtoLink('S', Array.from({ length: 200 }, (_, i) => `person${i}@a-rather-long-domain-name.example.com`).join(','));
    expect(many.length).toBeLessThanOrEqual(MAX_LINK);
    expect(isSafeMailto(many)).toBe(true);
    expect(parse(many).to.split(',').length).toBeGreaterThan(3);
  });

  it('recognises only links of this shape as safe to open', () => {
    for (const link of [
      'https://example.com/?subject=a&body=b',
      'mailto:a@example.com?subject=a&body=b&bcc=c@example.com',
      'mailto:a@example.com?bcc=c@example.com&subject=a&body=b',
      'mailto:a@example.com?subject=a&body=b\nBcc: x',
      'mailto:a@example.com?subject=a b&body=b',
      'mailto:a@example.com?subject=a&body=' + 'b'.repeat(MAX_LINK),
      'file:///etc/passwd',
      'command:workbench.action.terminal.new',
      ' mailto:?subject=a&body=b',
    ]) {
      expect(isSafeMailto(link), link).toBe(false);
    }
  });
});

describe('HTML for pasting into a mail', () => {
  it('puts the look of every element on the element itself', () => {
    const out = html('# Title\n\nSome *text* with `code` and a [link](https://example.com/a?b=1&c=2).\n\n> quote\n\n- one\n- two\n\n1. first\n\n---\n');
    expect(out).toMatch(/^<div style="font-family:[^"]+;font-size:14px;[^"]+">\n<h1 style="[^"]*font-size:24px">Title<\/h1>/);
    expect(out).toContain('<p style="margin:0 0 12px">Some <em>text</em> with <code style="font-family:ui-monospace');
    expect(out).toContain('<a href="https://example.com/a?b=1&amp;c=2" style="color:#0969da;text-decoration:underline">link</a>');
    expect(out).toMatch(/<blockquote style="[^"]*border-left:4px solid #d1d9e0[^"]*">\n<p style=/);
    expect(out).toMatch(/<ul style="[^"]*padding-left:28px">\n<li style="margin:2px 0">one<\/li>/);
    expect(out).toMatch(/<ol style="[^"]+">\n<li style=/);
    expect(out).toMatch(/<hr style="border:0;border-top:1px solid #d1d9e0;[^"]*">/);
    // Nothing a mail program throws away is relied on.
    expect(out).not.toMatch(/ class=| id=|<style|<script|<link/);
    expect(out.trimEnd().endsWith('</div>')).toBe(true);
  });

  it('gives tables borders and padding, and keeps the alignment of their columns', () => {
    const out = html('| a | b | c |\n| :- | :-: | -: |\n| 1 | 2 | 3 |\n');
    expect(out).toContain('<table style="border-collapse:collapse;margin:0 0 12px">');
    expect(out).toContain('<th style="border:1px solid #d1d9e0;padding:6px 12px;background-color:#f6f8fa;font-weight:600;text-align:left">a</th>');
    expect(out).toContain('<td style="border:1px solid #d1d9e0;padding:6px 12px;text-align:center">2</td>');
    expect(out).toContain('<td style="border:1px solid #d1d9e0;padding:6px 12px;text-align:right">3</td>');
    expect(out.match(/<t[dh] style="border:1px solid/g)).toHaveLength(6);
  });

  it('sets code in a monospace font on a light background, without colours that need a style sheet', () => {
    const out = html('```js\nconst a = "<b>" & 1;\n```\n\n    indented <i>\n\n```\nplain\n```\n');
    expect(out).toContain('<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas');
    expect(out).toMatch(/<pre style="[^"]*background-color:#f6f8fa[^"]*white-space:pre-wrap[^"]*">const a = &quot;&lt;b&gt;&quot; &amp; 1;<\/pre>/);
    expect(out).toMatch(/<pre style="[^"]+">indented &lt;i&gt;<\/pre>/);
    expect(out).not.toContain('tok-');
    expect(out.match(/<pre /g)).toHaveLength(3);
  });

  it('keeps web links and turns links that only work next to the file into text', () => {
    const out = html('[web](https://example.com) [mail](mailto:a@example.com) [note](other.md#part) [anchor](#title) [ftp](ftp://x/y) <https://auto.example> https://bare.example/x\n\n# Title\n');
    expect(out.match(/<a href="[^"]*"/g)).toEqual(['<a href="https://example.com"', '<a href="mailto:a@example.com"', '<a href="https://auto.example"', '<a href="https://bare.example/x"']);
    expect(out).toContain('<span>note</span> <span>anchor</span> <span>ftp</span>');
  });

  it('leaves local images out with their alt text and keeps images from the web', () => {
    const out = renderEmail('![The pipeline](assets/diagram.svg) ![](x.png) ![remote](https://example.com/p.png "t")\n\n<img src="assets/photo.png" alt="A &quot;photo&quot;" width="10"> <img src="https://example.com/q.png">\n');
    expect(out.omittedImages).toBe(3);
    expect(out.html).toContain('<em style="color:#59636e">[Image: The pipeline]</em> <em style="color:#59636e">[Image]</em>');
    expect(out.html).toContain('<img src="https://example.com/p.png" alt="remote" title="t" style="max-width:100%;height:auto">');
    expect(out.html).toContain('[Image: A &quot;photo&quot;]');
    expect(out.html).toContain('<img src="https://example.com/q.png">');
    expect(out.html).not.toMatch(/src="(?!https:)/);
    expect(out.html).not.toContain('data:');
  });

  it('writes math as its TeX source and replaces a diagram by a note', () => {
    const out = renderEmail('Inline $e^{i\\pi}+1=0$ and $$x<y$$, price $5.\n\n$$\n\\frac{a}{b} < c\n$$\n\n```mermaid\nflowchart LR\n  A --> B\n```\n');
    expect(out.html).toContain('>$e^{i\\pi}+1=0$</code>');
    expect(out.html).toContain('>$$x&lt;y$$</code>, price $5.');
    expect(out.html).toMatch(/<pre style="[^"]+">\\frac\{a\}\{b\} &lt; c<\/pre>/);
    expect(out.html).not.toMatch(/<math|katex|<svg/);
    expect(out.omittedDiagrams).toBe(1);
    expect(out.html).toContain('[Diagram left out]');
    expect(out.html).not.toContain('flowchart');
  });

  it('writes tasks, alerts and footnotes in a form that survives', () => {
    const out = html('- [ ] open\n- [x] done\n\n> [!WARNING]\n> Careful.\n\nText[^n] again[^n] and[^m].\n\n[^m]: Second, with a [link](https://example.com).\n[^n]: First *note*.\n');
    expect(out).toMatch(/<ul style="[^"]*list-style:none[^"]*">\n<li style="margin:2px 0">☐ open<\/li>\n<li style="margin:2px 0">☑ done<\/li>/);
    expect(out).not.toContain('<input');
    expect(out).toMatch(/<blockquote style="margin:0 0 12px;padding:8px 12px;border-left:4px solid #9a6700">\n<p style="[^"]+"><strong style="color:#9a6700">Warning<\/strong><br>\nCareful\.<\/p>/);
    expect(out).toContain('Text<sup style="font-size:75%;line-height:0">[1]</sup> again<sup style="font-size:75%;line-height:0">[1]</sup> and<sup style="font-size:75%;line-height:0">[2]</sup>.');
    expect(out).toMatch(/<hr style="[^"]+">\n<ol style="[^"]+">\n<li style="margin:2px 0" value="1">First <em>note<\/em>\.<\/li>\n<li style="margin:2px 0" value="2">Second, with a <a href="https:\/\/example\.com" style="[^"]+">link<\/a>\.<\/li>\n<\/ol>/);
    expect(out).not.toMatch(/href="#/);
  });

  it('drops scripts, styles, frames, forms and event handlers from the HTML of the document', () => {
    const out = html(
      [
        'Text <kbd>Ctrl</kbd><br>more <b onclick="alert(1)" title="t">bold</b> <input value="x"><button>go</button>',
        '',
        '<script>alert(1)</script>',
        '',
        '<style>p { color: red }</style>',
        '',
        '<iframe src="https://evil.example"></iframe>',
        '',
        '<div onmouseover=steal() align="center">kept</div>',
        '',
        '<form action="https://evil.example"><p>inside</p></form>',
        '',
        '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">',
      ].join('\n'),
    );
    expect(out).toContain('<kbd>Ctrl</kbd><br>more <b title="t">bold</b>');
    expect(out).toContain('<div align="center">kept</div>');
    expect(out).toContain('<p>inside</p>');
    expect(out).not.toMatch(/<script|<style|<iframe|<form|<input|<button|<link|<meta|<base|onclick|onmouseover|alert\(1\)|color: red|evil\.example/);
  });

  it('takes the title from the first heading, strips front matter and counts nothing twice', () => {
    const source = '---\ntitle: hidden\n---\n\nIntro\n\n## The *real* `title`\n\n![a](a.png)\n';
    expect(renderEmail(source)).toMatchObject({ title: 'The real title', omittedImages: 1, omittedDiagrams: 0 });
    expect(renderEmail(source)).toEqual(renderEmail(source));
    expect(renderEmail(source).html).not.toContain('hidden');
    expect(renderEmail('no heading').title).toBe('');
  });

  it('leaves Copy as HTML and the exports exactly as they were', () => {
    const source = readFileSync(join(__dirname, '../../sample/features.md'), 'utf8') + '\n$x$\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nNote[^1].\n\n[^1]: text\n';
    const before = renderMarkdown(source).html;
    renderEmail(source);
    expect(renderMarkdown(source).html).toBe(before);
    expect(before).toContain('class="tok-keyword"');
    expect(before).toContain('<input type="checkbox" disabled checked>');
    expect(before).not.toContain('style="margin:0 0 12px"');
  });

  it('renders the samples without anything a mail cannot show', () => {
    for (const name of ['features.md', 'diagrams.md', 'footnotes.md']) {
      const out = renderEmail(readFileSync(join(__dirname, '../../sample', name), 'utf8'));
      expect(out.html, name).not.toMatch(/ class=|<style|<script|<math|<svg|<input|data:|href="(?!https?:|mailto:)|src="(?!https?:)/);
      expect(out.title, name).not.toBe('');
    }
    const features = renderEmail(readFileSync(join(__dirname, '../../sample/features.md'), 'utf8'));
    expect(features.omittedImages).toBe(4);
    expect(renderEmail(readFileSync(join(__dirname, '../../sample/diagrams.md'), 'utf8')).omittedDiagrams).toBe(1);
  });
});

describe('where Email Document is offered', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const menus = pkg.contributes.menus as Record<string, { command: string; when?: string; group?: string }[]>;
  const entry = (menu: string) => menus[menu].find((item) => item.command === 'seamlessMarkdown.emailDocument');

  it('in the same places as the exports', () => {
    expect(pkg.contributes.commands.find((c: { command: string }) => c.command === 'seamlessMarkdown.emailDocument')).toMatchObject({ title: 'Email Document…', category: 'Seamless Markdown' });
    for (const menu of ['commandPalette', 'explorer/context', 'editor/title']) {
      const html = menus[menu].find((item) => item.command === 'seamlessMarkdown.exportHtml')!;
      expect(entry(menu)?.when, menu).toBe(html.when);
    }
    expect(entry('editor/title')?.group).toBe('seamlessMarkdown.export@3');
    expect(entry('explorer/context')?.group).toBe('seamlessMarkdown.export@3');
  });

  it('has one setting, the recipient', () => {
    const settings = Object.keys(pkg.contributes.configuration.properties).filter((name) => name.startsWith('seamlessMarkdown.email.'));
    expect(settings).toEqual(['seamlessMarkdown.email.to']);
    expect(pkg.contributes.configuration.properties['seamlessMarkdown.email.to']).toMatchObject({ type: 'string', default: '' });
  });
});
