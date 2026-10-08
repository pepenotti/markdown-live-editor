// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { type HtmlNode, convertNode, escapeText, htmlToMarkdown, isCodeDump, markdownForPaste, parseHtml } from '../../src/webview/htmlToMarkdown';

const md = htmlToMarkdown;

describe('inline formatting', () => {
  it('converts bold, italic, strikethrough and inline code', () => {
    expect(md('<p>a <b>bold</b> and <strong>strong</strong></p>')).toBe('a **bold** and **strong**');
    expect(md('<p>an <i>italic</i> and <em>em</em></p>')).toBe('an *italic* and *em*');
    expect(md('<p><s>one</s> <del>two</del> <strike>three</strike></p>')).toBe('~~one~~ ~~two~~ ~~three~~');
    expect(md('<p>run <code>npm test</code> now</p>')).toBe('run `npm test` now');
  });

  it('nests marks', () => {
    expect(md('<b><i>both</i></b>')).toBe('***both***');
    expect(md('<b>bold <i>both</i></b>')).toBe('**bold *both***');
    expect(md('<del><b>gone</b></del>')).toBe('~~**gone**~~');
    expect(md('<b><code>x</code></b>')).toBe('**`x`**');
  });

  it('keeps white space outside the markers', () => {
    expect(md('<p>a<b> bold </b>b</p>')).toBe('a **bold** b');
    expect(md('<p><i>one </i>two</p>')).toBe('*one* two');
    expect(md('<p>a <b> </b> b</p>')).toBe('a b');
  });

  it('joins neighbours with the same formatting and does not double nested marks', () => {
    expect(md('<b>one</b><b> two</b>')).toBe('**one two**');
    expect(md('<b><strong>x</strong></b>')).toBe('**x**');
    expect(md('<span style="font-weight:700">a</span><span style="font-weight:700">b</span>c')).toBe('**ab**c');
  });

  it('writes code spans that contain backticks', () => {
    expect(md('<code>a`b</code>')).toBe('``a`b``');
    expect(md('<code>`x`</code>')).toBe('`` `x` ``');
    expect(md('<code>a * b_c [d]</code>')).toBe('`a * b_c [d]`');
  });

  it('converts line breaks', () => {
    expect(md('<p>one<br>two</p>')).toBe('one\\\ntwo');
    expect(md('<p>one<br></p>')).toBe('one');
    expect(md('one<br><br>two')).toBe('one\n\ntwo');
    expect(md('<p><b>one<br>two</b></p>')).toBe('**one\\\ntwo**');
  });

  it('collapses white space like a browser', () => {
    expect(md('<p>  a \n  b&nbsp;&nbsp;c  </p>')).toBe('a b c');
    expect(md('<p>a</p>\n\n   <p>b</p>')).toBe('a\n\nb');
  });
});

describe('links and images', () => {
  it('converts links', () => {
    expect(md('<a href="https://example.com/a">text</a>')).toBe('[text](https://example.com/a)');
    expect(md('see <a href="https://example.com"><b>this</b> page</a>.')).toBe('see [**this** page](https://example.com).');
    expect(md('<a href="#top">up</a> <a href="/docs/a.md">rel</a>')).toBe('[up](#top) [rel](/docs/a.md)');
    expect(md('<a href="mailto:a@b.co">mail</a>')).toBe('[mail](mailto:a@b.co)');
  });

  it('writes a link whose text is its address as an autolink', () => {
    expect(md('<a href="https://example.com/x">https://example.com/x</a>')).toBe('<https://example.com/x>');
  });

  it('keeps destinations intact', () => {
    expect(md('<a href="https://e.com/a b">x</a>')).toBe('[x](https://e.com/a%20b)');
    expect(md('<a href="https://en.wikipedia.org/wiki/Rust_(language)">Rust</a>')).toBe('[Rust](https://en.wikipedia.org/wiki/Rust_(language))');
    expect(md('<a href="https://e.com/a)b">x</a>')).toBe('[x](https://e.com/a%29b)');
  });

  it('escapes brackets in link text', () => {
    expect(md('<a href="https://e.com">[1]</a>')).toBe('[\\[1\\]](https://e.com)');
  });

  it('drops empty links and links without an address', () => {
    expect(md('a<a href="https://e.com"></a>b <a name="x">c</a>')).toBe('ab c');
  });

  it('converts images and keeps a remote address as it is', () => {
    expect(md('<img src="https://e.com/a.png" alt="A cat">')).toBe('![A cat](https://e.com/a.png)');
    expect(md('<img src="https://e.com/a.png">')).toBe('![](https://e.com/a.png)');
    expect(md('<a href="https://e.com"><img src="https://e.com/a.png" alt="x"></a>')).toBe('[![x](https://e.com/a.png)](https://e.com)');
    expect(md('<p>see <img src="pics/a.png" alt="[a]"> here</p>')).toBe('see ![\\[a\\]](pics/a.png) here');
  });

  it('drops images that are not on the web', () => {
    expect(md('a<img src="data:image/png;base64,AAAA" alt="x">b')).toBe('ab');
    expect(md('a<img src="file:///C:/tmp/clip_image001.png">b')).toBe('ab');
    expect(md('a<img alt="x">b')).toBe('ab');
  });
});

describe('blocks', () => {
  it('converts headings', () => {
    expect(md('<h1>One</h1><h2>Two</h2><h6>Six</h6>')).toBe('# One\n\n## Two\n\n###### Six');
    expect(md('<h2><strong>Bold</strong> and <em>it</em></h2>')).toBe('## Bold and *it*');
    expect(md('<h3>a<br>b</h3>')).toBe('### a b');
    expect(md('<h2> </h2><p>x</p>')).toBe('x');
  });

  it('separates paragraphs and other containers', () => {
    expect(md('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(md('<div>one</div><div>two</div>')).toBe('one\n\ntwo');
    expect(md('loose<p>para</p>tail')).toBe('loose\n\npara\n\ntail');
    expect(md('<div><div><p>deep</p></div></div>')).toBe('deep');
  });

  it('converts block quotes', () => {
    expect(md('<blockquote>quoted</blockquote>')).toBe('> quoted');
    expect(md('<blockquote><p>one</p><p>two</p></blockquote>')).toBe('> one\n>\n> two');
    expect(md('<blockquote><p>a</p><blockquote>b</blockquote></blockquote>')).toBe('> a\n>\n> > b');
    expect(md('<blockquote><ul><li>a</li><li>b</li></ul></blockquote>')).toBe('> - a\n> - b');
  });

  it('converts rules', () => {
    expect(md('<p>a</p><hr><p>b</p>')).toBe('a\n\n---\n\nb');
  });

  it('converts code blocks', () => {
    expect(md('<pre><code>const a = 1;\nconst b = 2;\n</code></pre>')).toBe('```\nconst a = 1;\nconst b = 2;\n```');
    expect(md('<pre>  keep   spaces\n\tand *stars*</pre>')).toBe('```\n  keep   spaces\n\tand *stars*\n```');
    expect(md('<pre>a<br>b</pre>')).toBe('```\na\nb\n```');
  });

  it('takes the language of a code block from its class', () => {
    expect(md('<pre><code class="language-ts">let a;</code></pre>')).toBe('```ts\nlet a;\n```');
    expect(md('<pre class="lang-python hljs"><code>x = 1</code></pre>')).toBe('```python\nx = 1\n```');
    expect(md('<pre><code class="hljs language-c++">int a;</code></pre>')).toBe('```c++\nint a;\n```');
    expect(md('<div class="highlight highlight-source-js"><pre><span class="pl-k">let</span> a;</pre></div>')).toBe('```js\nlet a;\n```');
  });

  it('uses a longer fence around code that holds a fence', () => {
    expect(md('<pre>```\ninner\n```</pre>')).toBe('````\n```\ninner\n```\n````');
  });
});

describe('lists', () => {
  it('converts bullet and numbered lists', () => {
    expect(md('<ul><li>a</li><li>b</li></ul>')).toBe('- a\n- b');
    expect(md('<ol><li>a</li><li>b</li></ol>')).toBe('1. a\n2. b');
    expect(md('<ol start="4"><li>a</li><li>b</li></ol>')).toBe('4. a\n5. b');
    expect(md('<ul>\n  <li>\n    a\n  </li>\n  <li><p>b</p></li>\n</ul>')).toBe('- a\n- b');
  });

  it('nests lists', () => {
    expect(md('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>')).toBe('- a\n  - b\n    - c\n- d');
    expect(md('<ol><li>a<ul><li>b</li></ul></li><li>c<ol><li>d</li></ol></li></ol>')).toBe('1. a\n   - b\n2. c\n   1. d');
  });

  it('nests a list that sits next to its item, as Google Docs writes it', () => {
    expect(md('<ul><li>a</li><ul><li>b</li></ul><li>c</li></ul>')).toBe('- a\n  - b\n- c');
  });

  it('makes a list loose when an item has several paragraphs', () => {
    expect(md('<ul><li><p>a</p><p>b</p></li><li>c</li></ul>')).toBe('- a\n\n  b\n\n- c');
    expect(md('<ol><li>a<pre>code</pre></li></ol>')).toBe('1. a\n\n   ```\n   code\n   ```');
  });

  it('converts task lists', () => {
    expect(md('<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> open</li></ul>')).toBe('- [x] done\n- [ ] open');
    expect(md('<ul class="contains-task-list"><li class="task-list-item"><p><input type="checkbox" disabled checked=""> a</p></li></ul>')).toBe('- [x] a');
    expect(md('<ul><li><label><input type="checkbox"><span>a</span></label><ul><li><input type="checkbox" checked>b</li></ul></li></ul>')).toBe('- [ ] a\n  - [x] b');
    expect(md('<ul><li role="checkbox" aria-checked="true"><p>a</p></li><li role="checkbox" aria-checked="false"><p>b</p></li></ul>')).toBe('- [x] a\n- [ ] b');
  });

  it('skips empty items and handles an item on its own', () => {
    expect(md('<ul><li>a</li><li> </li></ul>')).toBe('- a');
    expect(md('<li>alone</li>')).toBe('- alone');
  });
});

describe('tables', () => {
  it('converts a table with a header', () => {
    expect(md('<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>Apple</td><td>3</td></tr><tr><td>Fig</td><td>12</td></tr></tbody></table>')).toBe(
      ['| Name  | Qty |', '| ----- | --- |', '| Apple | 3   |', '| Fig   | 12  |'].join('\n'),
    );
  });

  it('uses the first row as the header when there is none', () => {
    expect(md('<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>')).toBe(['| a   | b   |', '| --- | --- |', '| c   | d   |'].join('\n'));
  });

  it('keeps inline formatting in cells and escapes pipes', () => {
    const lines = md('<table><tr><th><b>H</b></th><th>x</th></tr><tr><td><b>b</b> <a href="https://e.com">l</a></td><td>a|b<br>c</td></tr></table>').split('\n');
    expect(lines[0]).toMatch(/^\| H +\| x +\|$/);
    expect(lines[2]).toBe('| **b** [l](https://e.com) | a\\|b<br>c |');
  });

  it('reads column alignment from the header', () => {
    expect(md('<table><tr><th align="right">a</th><th style="text-align: center">b</th><th>c</th></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>')).toBe(
      ['|   a |  b  | c   |', '| --: | :-: | --- |', '|   1 |  2  | 3   |'].join('\n'),
    );
  });

  it('pads short rows and spans', () => {
    expect(md('<table><tr><td colspan="2">wide</td><td>c</td></tr><tr><td>1</td></tr></table>')).toBe(['| wide |     | c   |', '| ---- | --- | --- |', '| 1    |     |     |'].join('\n'));
  });

  it('does not escape a list marker or number at the start of a cell', () => {
    expect(md('<table><tr><td>- a</td><td>1. b</td></tr><tr><td># c</td><td>&gt; d</td></tr></table>')).toBe(['| - a | 1. b |', '| --- | ---- |', '| # c | > d  |'].join('\n'));
  });

  it('unwraps layout tables', () => {
    expect(md('<table><tr><td><p>just <b>text</b></p></td></tr></table>')).toBe('just **text**');
    expect(md('<table><tr><td><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></td><td>side</td></tr></table>')).toBe(
      ['| a   | b   |', '| --- | --- |', '| c   | d   |', '', 'side'].join('\n'),
    );
  });
});

describe('escaping', () => {
  it('escapes characters that would be read as Markdown', () => {
    expect(escapeText('*not* emphasis')).toBe('\\*not\\* emphasis');
    expect(escapeText('_x_ and __y__')).toBe('\\_x\\_ and \\_\\_y\\_\\_');
    expect(escapeText('a `tick`')).toBe('a \\`tick\\`');
    expect(escapeText('[text](url)')).toBe('\\[text](url)');
    expect(escapeText('<div> and </div> and <!-- c -->')).toBe('\\<div> and \\</div> and \\<!-- c -->');
    expect(escapeText('&amp; &#38; &copy;')).toBe('\\&amp; \\&#38; \\&copy;');
    expect(escapeText('~~gone~~')).toBe('\\~\\~gone\\~\\~');
    expect(escapeText('C:\\*.txt and a\\')).toBe('C:\\\\\\*.txt and a\\\\');
    expect(escapeText('$x$ math')).toBe('\\$x$ math');
  });

  it('leaves alone what is literal already', () => {
    for (const text of ['snake_case_name', '2 * 3 = 6', 'a < b > c', 'AT&T & co', 'x ~ y', 'costs $5 or $ 6', '$5 and $10', 'a ] b', 'see [1', 'C:\\Users\\me', 'wow! (really) #1 + 2 - 3 = 4.', 'a|b']) {
      expect(escapeText(text)).toBe(text);
    }
  });

  it('escapes the start of a line that would begin a block', () => {
    expect(md('<p># not a heading</p>')).toBe('\\# not a heading');
    expect(md('<p>- not a list</p><p>+ nor this</p><p>* nor this</p>')).toBe('\\- not a list\n\n\\+ nor this\n\n\\* nor this');
    expect(md('<p>1. not a list</p><p>2) nor this</p>')).toBe('1\\. not a list\n\n2\\) nor this');
    expect(md('<p>&gt; not a quote</p>')).toBe('\\> not a quote');
    expect(md('<p>---</p><p>a<br>===</p>')).toBe('\\---\n\na\\\n\\===');
    expect(md('<p>one<br># two</p>')).toBe('one\\\n\\# two');
  });

  it('does not escape where a block cannot start', () => {
    expect(md('<p>#hashtag, -5 degrees, 1.5 litres, 3 - 2</p>')).toBe('#hashtag, -5 degrees, 1.5 litres, 3 - 2');
    expect(md('<p><b>#</b> x</p>')).toBe('**#** x');
  });

  it('escapes inside formatting and list items', () => {
    expect(md('<b>a*b</b>')).toBe('**a\\*b**');
    expect(md('<ul><li># x</li><li>[ ] y</li></ul>')).toBe('- \\# x\n- \\[ ] y');
    expect(md('<h2>C# and *</h2>')).toBe('## C# and \\*');
  });
});

describe('untrusted content', () => {
  it('drops scripts, styles and other things that are not text', () => {
    expect(md('<p>a</p><script>alert(1)</script><style>p{color:red}</style><p>b</p>')).toBe('a\n\nb');
    expect(md('<head><title>T</title><meta charset="utf-8"><link rel="stylesheet" href="x.css"></head><body>text<noscript>no</noscript><template>t</template></body>')).toBe('text');
    expect(md('a<iframe src="https://e.com"></iframe><object data="x"></object><svg><text>s</text></svg><button>go</button><select><option>o</option></select>b')).toBe('ab');
    expect(md('<p onclick="alert(1)" onmouseover="x()">safe</p>')).toBe('safe');
  });

  it('drops addresses with a scheme that is not allowed', () => {
    expect(md('<a href="javascript:alert(1)">x</a>')).toBe('x');
    expect(md('<a href=" JaVa\tScRiPt:alert(1)">x</a>')).toBe('x');
    expect(md('<a href="java&#10;script:alert(1)">x</a>')).toBe('x');
    expect(md('<a href="vbscript:x">x</a> <a href="data:text/html,<script>1</script>">y</a> <a href="file:///etc/passwd">z</a>')).toBe('x y z');
    expect(md('<img src="javascript:alert(1)" alt="x">')).toBe('');
    expect(markdownForPaste('<a href="javascript:alert(1)">x</a>')).toBeNull();
  });

  it('does not let text break out of a link or an image', () => {
    expect(md('<a href="https://e.com/)[x](javascript:alert(1)">t</a>')).toBe('[t](https://e.com/%29[x]%28javascript:alert%281%29)');
    expect(md('<a href="https://e.com">a](javascript:x) [b</a>')).toBe('[a\\](javascript:x) \\[b](https://e.com)');
    expect(md('<img src="https://e.com/a.png" alt="x](javascript:y)">')).toBe('![x\\](javascript:y)](https://e.com/a.png)');
    expect(md('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')).toBe('\\<script>alert(1)\\</script>');
  });

  it('skips hidden content', () => {
    expect(md('a<span style="display:none">secret</span><span hidden>x</span>b')).toBe('ab');
  });

  it('does not run or load anything while parsing', () => {
    const before = document.body.innerHTML;
    (globalThis as { pwned?: boolean }).pwned = false;
    md('<img src="x" onerror="globalThis.pwned = true"><script>globalThis.pwned = true</script><b>x</b>');
    expect((globalThis as { pwned?: boolean }).pwned).toBe(false);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('Google Docs', () => {
  const span = (text: string, style = '') =>
    `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;${style}">${text}</span>`;
  const wrap = (inner: string) => `<meta charset='utf-8'><meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1a2b3c4d-7fff-0000-1111-222233334444">${inner}</b><br class="Apple-interchange-newline">`;
  const p = (inner: string) => `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;">${inner}</p>`;

  it('ignores the bold wrapper and reads formatting from styles', () => {
    const html = wrap(
      `<h1 dir="ltr" style="line-height:1.38;">${span('Title', 'font-size:20pt;')}</h1>` +
        p(span('Plain, ') + span('bold', 'font-weight:700;') + span(', ') + span('italic', 'font-style:italic;') + span(', ') + span('both', 'font-weight:700;font-style:italic;') + span(' and ') + span('gone', 'text-decoration:line-through;') + span('.')) +
        '<br>' +
        p(`<a href="https://example.com/" style="text-decoration:none;">${span('a link', 'color:#1155cc;text-decoration:underline;')}</a>`),
    );
    expect(md(html)).toBe('# Title\n\nPlain, **bold**, *italic*, ***both*** and ~~gone~~.\n\n[a link](https://example.com/)');
  });

  it('converts its lists', () => {
    const li = (inner: string) => `<li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1">${p(span(inner))}</li>`;
    const html = wrap(`<ul style="margin-top:0;margin-bottom:0;">${li('one')}<ul style="margin-top:0;">${li('nested')}</ul>${li('two')}</ul>`);
    expect(md(html)).toBe('- one\n  - nested\n- two');
  });

  it('pastes an unformatted copy as plain text', () => {
    expect(markdownForPaste(wrap(span('Just a sentence.')))).toBeNull();
    expect(markdownForPaste(wrap(p(span('One.')) + p(span('Two.'))))).toBeNull();
  });

  it('reads a fixed-width span as code', () => {
    expect(md(wrap(p(span('run ') + span('npm ci', "font-family:'Courier New',monospace;") + span(' first'))))).toBe('run `npm ci` first');
  });
});

describe('Word', () => {
  const head = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><!--[if gte mso 9]><xml><o:OfficeDocumentSettings><o:AllowPNG/></o:OfficeDocumentSettings></xml><![endif]--><style><!-- p.MsoNormal {margin:0cm;font-family:"Calibri",sans-serif;} --></style></head><body lang=EN-GB style='tab-interval:36.0pt'><!--StartFragment-->`;
  const tail = '<!--EndFragment--></body></html>';
  const item = (level: number, marker: string, text: string) =>
    `<p class=MsoListParagraphCxSpMiddle style='text-indent:-18.0pt;mso-list:l0 level${level} lfo1'><![if !supportLists]><span style='font-family:Symbol;mso-fareast-font-family:Symbol'><span style='mso-list:Ignore'>${marker}<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><![endif]><span lang=EN-US>${text}<o:p></o:p></span></p>`;

  it('drops its markup noise', () => {
    const html = `${head}<h1><span lang=EN-US style='mso-ansi-language:EN-US'>Report<o:p></o:p></span></h1><p class=MsoNormal><span lang=EN-US style='mso-ansi-language:EN-US'>Some <b style='mso-bidi-font-weight:normal'>bold</b> and <i style='mso-bidi-font-style:normal'>italic</i><span style='mso-spacerun:yes'>  </span>text.<o:p></o:p></span></p><p class=MsoNormal><o:p>&nbsp;</o:p></p>${tail}`;
    expect(md(html)).toBe('# Report\n\nSome **bold** and *italic* text.');
  });

  it('rebuilds lists from list paragraphs', () => {
    const html = `${head}<p class=MsoNormal>Before</p>${item(1, '·', 'one')}${item(2, 'o', 'nested')}${item(2, 'o', 'more')}${item(1, '·', 'two')}<p class=MsoNormal>After</p>${tail}`;
    expect(md(html)).toBe('Before\n\n- one\n  - nested\n  - more\n- two\n\nAfter');
  });

  it('rebuilds numbered lists', () => {
    const html = `${head}${item(1, '1.', 'one')}\n\n${item(2, 'a.', 'sub')}${item(1, '2.', 'two')}${tail}`;
    expect(md(html)).toBe('1. one\n   1. sub\n2. two');
  });
});

describe('real-world shapes', () => {
  it('converts a copy from a web page', () => {
    const html =
      '<meta charset=\'utf-8\'><h2 style="box-sizing: border-box; margin-top: 24px; font-weight: 600;">Install</h2>' +
      '<p style="box-sizing: border-box; margin-top: 0px;">Run <code style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace;">npm ci</code>, then read the <a href="https://example.com/docs" rel="nofollow" style="color: rgb(9, 105, 218);">docs</a>:</p>' +
      '<div class="highlight highlight-source-shell" dir="auto"><pre>npm run build\nnpm <span class="pl-c1">test</span></pre></div>' +
      '<ul style="padding-left: 2em;"><li style="box-sizing: border-box;">fast</li><li style="margin-top: 0.25em;"><strong>small</strong></li></ul>';
    expect(md(html)).toBe('## Install\n\nRun `npm ci`, then read the [docs](https://example.com/docs):\n\n```shell\nnpm run build\nnpm test\n```\n\n- fast\n- **small**');
  });

  it('reads a bold or italic style on a span copied out of a page', () => {
    expect(md('<span style="color: rgb(0, 0, 0); font-weight: 700; font-style: italic;">text</span>')).toBe('***text***');
    expect(md('<span style="font-weight: bold">a</span> <span style="font-weight: 400">b</span>')).toBe('**a** b');
  });

  it('converts spreadsheet cells to one table', () => {
    const html =
      '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>' +
      '<table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody>' +
      '<tr style="height:21px;"><td style="font-weight:bold;" data-sheets-value="{}">Item</td><td style="font-weight:bold;">Price</td></tr>' +
      '<tr style="height:21px;"><td>Tea</td><td style="text-align:right;">4</td></tr></tbody></table>';
    expect(md(html)).toBe(['| Item | Price |', '| ---- | ----- |', '| Tea  | 4     |'].join('\n'));
  });

  it('pastes a single spreadsheet cell as plain text', () => {
    expect(markdownForPaste('<style>td {border: 1px solid #ccc;}</style><table><tbody><tr><td style="font-weight:normal">42</td></tr></tbody></table>')).toBeNull();
  });
});

describe('markdownForPaste', () => {
  it('converts formatted content', () => {
    expect(markdownForPaste('<p>a <b>b</b></p>')).toEqual({ markdown: 'a **b**', rich: true, block: false });
    expect(markdownForPaste('<h1>T</h1>')).toEqual({ markdown: '# T', rich: true, block: true });
    expect(markdownForPaste('<p>a <b>b</b></p><p>c</p>')?.block).toBe(true);
    expect(markdownForPaste('<ul><li>a</li></ul>')?.block).toBe(true);
    expect(markdownForPaste('<p><img src="https://e.com/a.png"></p>')).toEqual({ markdown: '![](https://e.com/a.png)', rich: true, block: false });
  });

  it('leaves plain text to the default paste', () => {
    expect(markdownForPaste('')).toBeNull();
    expect(markdownForPaste('just text')).toBeNull();
    expect(markdownForPaste('<meta charset="utf-8"><span style="color: rgb(36, 41, 47); font-size: 16px; font-weight: 400;">just text</span>')).toBeNull();
    expect(markdownForPaste('<div><p>one</p><p>two<br>three</p></div>')).toBeNull();
    expect(markdownForPaste('<p> </p><script>x</script>')).toBeNull();
    expect(markdownForPaste('<b> </b>')).toBeNull();
  });

  it('leaves a copy from a code editor to the default paste', () => {
    const vscode =
      '<meta charset=\'utf-8\'><div style="color: #cccccc;background-color: #1f1f1f;font-family: Menlo, Monaco, \'Courier New\', monospace;font-weight: normal;font-size: 12px;line-height: 18px;white-space: pre;"><div><span style="color: #569cd6;">const</span><span style="color: #cccccc;"> </span><span style="color: #4fc1ff;">a</span></div></div>';
    expect(markdownForPaste(vscode)).toBeNull();
    expect(markdownForPaste('<p><b>bold</b></p>', ['text/plain', 'text/html', 'vscode-editor-data'])).toBeNull();
    expect(markdownForPaste('<meta charset="utf-8"><pre style="color:#000"><span style="font-weight:bold">let</span> a</pre>')).toBeNull();
    expect(markdownForPaste('<html><body><!--StartFragment--><div style="background:#fff"><pre style="font-family:\'JetBrains Mono\',monospace;"><span style="color:#0033b3;font-weight:bold">val</span> a</pre></div><!--EndFragment--></body></html>')).toBeNull();
  });

  it('still converts code that comes with other content', () => {
    expect(markdownForPaste('<p>Run:</p><pre>npm ci</pre>')?.markdown).toBe('Run:\n\n```\nnpm ci\n```');
    expect(markdownForPaste('<code>npm ci</code>')?.markdown).toBe('`npm ci`');
  });

  it('gives up on a huge clipboard', () => {
    expect(markdownForPaste('<b>' + 'x'.repeat(4_000_001) + '</b>')).toBeNull();
  });
});

describe('the tree walk', () => {
  const text = (value: string): HtmlNode => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
  const el = (name: string, attrs: Record<string, string>, ...children: HtmlNode[]): HtmlNode => ({
    nodeType: 1,
    nodeName: name.toUpperCase(),
    nodeValue: null,
    childNodes: children,
    getAttribute: (n) => attrs[n] ?? null,
  });

  it('needs nothing but the minimal node interface', () => {
    const root = el('body', {}, el('h2', {}, text('Hi')), el('p', {}, text('a '), el('a', { href: 'https://e.com' }, text('link')), { nodeType: 8, nodeName: '#comment', nodeValue: 'note', childNodes: [] }));
    expect(convertNode(root)).toEqual({ markdown: '## Hi\n\na [link](https://e.com)', rich: true, block: true });
  });

  it('detects a code dump', () => {
    expect(isCodeDump(parseHtml('<pre>x</pre>'))).toBe(true);
    expect(isCodeDump(parseHtml('<p>a</p><pre>x</pre>'))).toBe(false);
    expect(isCodeDump(parseHtml('<div style="font-family: Consolas, monospace">x</div>'))).toBe(true);
    expect(isCodeDump(parseHtml('<div style="font-family: Arial">x</div>'))).toBe(false);
  });
});
