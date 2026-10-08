// Export: drawn diagrams, styled math with embedded fonts, and the headless browser session.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BrowserSession } from '../../src/extension/browser';
import { contentSecurityPolicy, mermaidSources, renderDocument, renderMarkdown } from '../../src/shared/exportHtml';
import { katexFontsFor, katexStyles } from '../../src/shared/katexCss';

const KATEX = join(__dirname, '../../node_modules/katex/dist');
const css = readFileSync(join(KATEX, 'katex.min.css'), 'utf8');
const font = (name: string) => readFileSync(join(KATEX, 'fonts', `${name}.woff2`)).toString('base64');
const katex = { css, font };

describe('diagrams in exported HTML', () => {
  const doc = ['# D', '```mermaid', 'flowchart LR', '  A --> B', '```', 'text', '~~~mermaid  title', 'pie', '~~~', '```js', 'mermaid()', '```', '    ```mermaid', '```MERMAID', 'bad', '```'].join('\n');
  const svg = (n: number) => `<svg id="mdl-diagram-${n}" viewBox="0 0 10 10"><style>#mdl-diagram-${n} .node{fill:red}</style><g class="node"></g></svg>`;

  it('finds the sources in the order they are rendered', () => {
    expect(mermaidSources(doc)).toEqual(['flowchart LR\n  A --> B\n', 'pie\n', 'bad\n']);
    expect(mermaidSources('---\ntitle: x\n---\n```mermaid\na\n```')).toEqual(['a\n']);
    expect(mermaidSources('no diagrams')).toEqual([]);
  });

  it('puts the drawings in as static SVG and keeps the source of the ones that failed', () => {
    const out = renderDocument(doc, { diagrams: [svg(1), null, svg(3)] });
    expect(out).toMatchObject({ diagrams: 3, diagramsDrawn: 2 });
    expect(out.html).toContain(`<figure class="diagram">${svg(1)}</figure>`);
    expect(out.html).toContain(`<figure class="diagram">${svg(3)}</figure>`);
    expect(out.html).toContain('<pre><code class="language-mermaid">pie\n</code></pre>');
    expect(out.html).not.toContain('flowchart LR');
    expect(out.html).toContain('<span class="tok-variableName">mermaid</span>');
    expect(out.html).not.toContain('<script');
    // Rendering twice gives the same result: the position of a diagram is not remembered between runs.
    expect(renderDocument(doc, { diagrams: [svg(1), null, svg(3)] }).html).toBe(out.html);
    expect(renderMarkdown(doc, { diagrams: [svg(1)] })).toMatchObject({ diagrams: 3, diagramsDrawn: 1 });
  });

  it('never lets a drawing bring a script or something that is not an SVG', () => {
    const out = renderDocument(doc, { diagrams: ['<svg><script>alert(1)</script></svg>', '<img src=x onerror=alert(1)>', '<svg><SCRIPT/></svg>'] });
    expect(out.diagramsDrawn).toBe(0);
    expect(out.html).not.toMatch(/<script|onerror/i);
    expect(out.html).toContain('<code class="language-mermaid">flowchart LR');
  });

  it('adds no script and no network address of its own, whatever is exported', () => {
    const { html } = renderDocument(`${doc}\n\n$x^2$\n`, { diagrams: [svg(1), svg(2), svg(3)], katex });
    expect(contentSecurityPolicy()).not.toMatch(/script-src|https?:/);
    expect(html).toContain(`content="${contentSecurityPolicy()}"`);
    expect(html).not.toMatch(/<script|<link|@import|cdn\./i);
    expect(html.replace(/http:\/\/www\.w3\.org\/[\w/]+/g, '')).not.toMatch(/https?:\/\//);
    expect(html).toContain('.diagram{');
  });
});

describe('math in exported documents', () => {
  const tex: Record<string, string> = {
    plain: 'e^{i\\pi}+1=0',
    fraction: '\\frac{a+b}{c}',
    integral: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}',
    sum: '\\sum_{k=1}^{n} k',
    matrix: '\\begin{pmatrix} a & b \\\\ c & d \\\\ e & f \\\\ g & h \\end{pmatrix}',
    fonts: '\\mathbb{R}, \\mathcal{L}, \\mathfrak{g}, \\mathbf{v}, \\boldsymbol{\\alpha}, \\mathsf{T}, \\mathtt{x}, \\mathscr{F}, \\mathit{d}, \\textbf{b} \\textit{i}',
    delims: '\\left( \\frac{\\frac{1}{2}}{\\frac{3}{4}} \\right) \\Bigg| \\big( x \\big)',
  };
  const display = (source: string) => renderMarkdown(`$$\n${source}\n$$`, { katex }).html;

  it('renders KaTeX layout with MathML beside it for a document, and MathML alone for a fragment', () => {
    const styled = renderMarkdown('Sum $a^2$.', { katex }).html;
    expect(styled).toContain('<span class="katex"><span class="katex-mathml"><math');
    expect(styled).toContain('<span class="katex-html" aria-hidden="true">');
    const fragment = renderMarkdown('Sum $a^2$.').html;
    expect(fragment).toContain('<span class="katex"><math');
    expect(fragment).not.toContain('katex-html');
    expect(display(tex.fraction)).toMatch(/^<div class="math-block"><span class="katex-display">/);
  });

  it('embeds the style sheet with only the fonts the formulas use', () => {
    const fontsIn = (html: string) => [...html.matchAll(/@font-face\{[^}]*?font-family:"?(KaTeX_\w+)"?;font-style:(\w+);font-weight:(\w+);/g)].map((m) => `${m[1]}/${m[3]}/${m[2]}`).sort();
    const simple = renderDocument(`$${tex.plain}$`, { katex }).html;
    expect(fontsIn(simple)).toEqual(['KaTeX_Main/400/normal', 'KaTeX_Math/400/italic']);
    expect(simple).toContain('src:url(data:font/woff2;base64,d09GMg');
    expect(simple).toContain('.katex{');
    // No file of the style sheet is referred to: every font that stayed is a data URI.
    expect(simple).not.toMatch(/url\((?!data:)/);
    expect(simple).not.toMatch(/\.woff|\.ttf/);

    expect(katexFontsFor(display(tex.integral))).toEqual(['KaTeX_Main-Regular', 'KaTeX_Math-Italic', 'KaTeX_Size2-Regular']);
    expect(katexFontsFor(display(tex.sum))).toContain('KaTeX_Size2-Regular');
    expect(katexFontsFor(renderMarkdown(`$${tex.sum}$`, { katex }).html)).toContain('KaTeX_Size1-Regular');
    // Tall brackets are drawn as SVG paths, not with a font.
    expect(katexFontsFor(display(tex.matrix))).toEqual(['KaTeX_Main-Regular', 'KaTeX_Math-Italic']);
    expect(katexFontsFor(display(tex.delims))).toEqual(expect.arrayContaining(['KaTeX_Size1-Regular', 'KaTeX_Size3-Regular']));
    expect(katexFontsFor(display(tex.fonts))).toEqual(
      expect.arrayContaining([
        'KaTeX_AMS-Regular',
        'KaTeX_Caligraphic-Regular',
        'KaTeX_Fraktur-Regular',
        'KaTeX_Main-Bold',
        'KaTeX_Main-Italic',
        'KaTeX_Math-BoldItalic',
        'KaTeX_SansSerif-Regular',
        'KaTeX_Script-Regular',
        'KaTeX_Typewriter-Regular',
      ]),
    );
    // Words in the text that look like class names ask for nothing.
    expect(katexFontsFor(renderMarkdown('mathbb mathfrak delimsizing size4 $x$', { katex }).html)).toEqual(['KaTeX_Main-Regular', 'KaTeX_Math-Italic']);
  });

  it('adds nothing for a document without math, and survives a missing font or style sheet', () => {
    const none = renderDocument('# No math, but $5 and $10');
    expect(renderDocument('# No math, but $5 and $10', { katex }).html).toBe(none.html);
    expect(katexStyles('<p>x</p>', css, font)).toBe('');
    const noFonts = katexStyles(renderMarkdown('$x$', { katex }).html, css, () => undefined);
    expect(noFonts).toContain('.katex{');
    expect(noFonts).not.toContain('@font-face');
    expect(katexStyles(renderMarkdown('$x$', { katex }).html, css, () => '"); } body { display: none')).not.toContain('display: none');
  });

  it('keeps a typical document small', () => {
    const plain = renderDocument(`# T\n\n$${tex.plain}$ and\n\n$$\n${tex.integral}\n$$\n`).html.length;
    const styled = renderDocument(`# T\n\n$${tex.plain}$ and\n\n$$\n${tex.integral}\n$$\n`, { katex }).html.length;
    // The style sheet, three fonts and the layout: well under a tenth of a megabyte.
    expect(styled - plain).toBeGreaterThan(20_000);
    expect(styled - plain).toBeLessThan(100_000);
  });
});

describe('the headless browser session', () => {
  const folder = mkdtempSync(join(tmpdir(), 'sm-fake-browser-'));
  afterAll(() => rmSync(folder, { recursive: true, force: true }));
  const PDF = '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\nstartxref\n9\n%%EOF\n';

  /**
   * A stand-in browser that speaks the DevTools pipe: requests arrive on descriptor 3 and
   * replies leave on 4, each ended by a zero byte. `behaviour` can change single replies.
   */
  function fakeBrowser(name: string, behaviour = ''): string {
    const file = join(folder, name);
    writeFileSync(
      file,
      `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(__filename + '.pid', String(process.pid));
fs.writeFileSync(__filename + '.args', JSON.stringify(process.argv.slice(2)));
const seen = [];
const out = fs.createWriteStream(null, { fd: 4 });
const send = (message) => out.write(JSON.stringify(message) + '\\0');
let reply = (m) => {
  if (m.method === 'Target.createTarget') return { targetId: 'target-1' };
  if (m.method === 'Target.attachToTarget') return { sessionId: 'session-1' };
  if (m.method === 'Page.navigate') {
    // The event can overtake the reply; the session has to cope with both orders.
    send({ method: 'Page.loadEventFired', sessionId: m.sessionId, params: {} });
    return { frameId: 'f' };
  }
  if (m.method === 'Runtime.evaluate') {
    if (m.params.expression.includes('fonts.ready')) return { result: { value: true } };
    const sources = JSON.parse(m.params.expression.slice(m.params.expression.lastIndexOf('})(') + 3, -1));
    return { result: { value: JSON.stringify(sources.map((s, i) => (s.includes('bad') ? null : '<svg id="d' + i + '">' + s.length + '</svg>'))) } };
  }
  if (m.method === 'Page.printToPDF') return { data: Buffer.from(${JSON.stringify(PDF)}).toString('base64') };
  return {};
};
${behaviour}
let buffer = '';
fs.createReadStream(null, { fd: 3 }).on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\0'); end >= 0; end = buffer.indexOf('\\0')) {
    const m = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    seen.push(m.method + (m.params && m.params.url ? ' ' + m.params.url : ''));
    fs.writeFileSync(__filename + '.seen', JSON.stringify(seen));
    const result = reply(m);
    if (result !== undefined) send(result.error ? { id: m.id, error: result.error } : { id: m.id, result });
  }
});
setInterval(() => {}, 1000);
`,
    );
    chmodSync(file, 0o755);
    return file;
  }
  const alive = (browser: string) => {
    try {
      process.kill(Number(readFileSync(browser + '.pid', 'utf8')), 0);
      return true;
    } catch {
      return false;
    }
  };
  const argsOf = (browser: string) => JSON.parse(readFileSync(browser + '.args', 'utf8')) as string[];
  const profileOf = (browser: string) => argsOf(browser).find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
  const page = join(folder, 'a page with spaces & --flag=like name.html');
  writeFileSync(page, '<p>x</p>');
  const unix = process.platform === 'win32' ? it.skip : it;

  unix('draws diagrams and prints in one session, then stops the browser and removes its profile', async () => {
    const browser = fakeBrowser('ok');
    const [drawn, pdf] = await BrowserSession.use(browser, async (session) => [await session.drawDiagrams(page, ['one', 'bad one', 'three!']), await session.printPdf(page)] as const, 10_000);
    expect(drawn).toEqual(['<svg id="d0">3</svg>', null, '<svg id="d2">6</svg>']);
    expect(pdf.toString('latin1')).toBe(PDF);
    // This stand-in never exits by itself, like the real browser on some machines.
    expect(alive(browser)).toBe(false);
    expect(existsSync(profileOf(browser))).toBe(false);
    // No path reaches the command line: the page is handed over through the protocol, as a URL.
    expect(argsOf(browser).filter((a) => !a.startsWith('--'))).toEqual(['about:blank']);
    expect(argsOf(browser).join(' ')).not.toContain('page with spaces');
    const seen = JSON.parse(readFileSync(browser + '.seen', 'utf8')) as string[];
    expect(seen.filter((s) => s.startsWith('Page.navigate'))).toHaveLength(2);
    for (const s of seen.filter((x) => x.startsWith('Page.navigate'))) expect(s).toMatch(/^Page\.navigate file:\/\/\/.*a%20page%20with%20spaces%20&%20--flag=like%20name\.html$/);
    // The page that draws diagrams is cut off from the network before anything is drawn.
    expect(seen.indexOf('Network.emulateNetworkConditions')).toBeGreaterThan(0);
    expect(seen.indexOf('Network.emulateNetworkConditions')).toBeLessThan(seen.indexOf('Runtime.evaluate'));
  });

  unix('asks the browser for nothing when there are no diagrams', async () => {
    const browser = fakeBrowser('none');
    expect(await BrowserSession.use(browser, (session) => session.drawDiagrams(page, []), 10_000)).toEqual([]);
    expect(existsSync(browser + '.seen')).toBe(false);
  });

  unix('gives up on a browser that never answers, and stops it', async () => {
    const browser = fakeBrowser('silent', 'reply = () => undefined;');
    const started = Date.now();
    await expect(BrowserSession.use(browser, (session) => session.printPdf(page), 700)).rejects.toThrow('did not finish in time');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(alive(browser)).toBe(false);
    expect(existsSync(profileOf(browser))).toBe(false);
  });

  unix('gives up when the page never finishes loading or a script never returns', async () => {
    const noLoad = fakeBrowser('no-load', `const first = reply; reply = (m) => (m.method === 'Page.navigate' ? { frameId: 'f' } : first(m));`);
    await expect(BrowserSession.use(noLoad, (session) => session.drawDiagrams(page, ['a']), 700)).rejects.toThrow('did not finish in time');
    expect(alive(noLoad)).toBe(false);
    const noScript = fakeBrowser('no-script', `const first = reply; reply = (m) => (m.method === 'Runtime.evaluate' ? undefined : first(m));`);
    await expect(BrowserSession.use(noScript, (session) => session.drawDiagrams(page, ['a']), 700)).rejects.toThrow('did not finish in time');
    expect(alive(noScript)).toBe(false);
  });

  unix('stops a browser that ignores being asked to', async () => {
    const browser = fakeBrowser('stubborn', `process.on('SIGTERM', () => {}); reply = () => undefined;`);
    await expect(BrowserSession.use(browser, (session) => session.printPdf(page), 500)).rejects.toThrow('did not finish in time');
    expect(alive(browser)).toBe(false);
  }, 15_000);

  unix('reports a browser that stops, refuses, or returns something that is not a PDF', async () => {
    const crash = fakeBrowser('crash', `console.error('boom: no usable sandbox'); process.exit(3);`);
    await expect(BrowserSession.use(crash, (session) => session.printPdf(page), 5000)).rejects.toThrow('boom: no usable sandbox');
    const refuse = fakeBrowser('refuse', `const first = reply; reply = (m) => (m.method === 'Page.printToPDF' ? { error: { message: 'Printing failed' } } : first(m));`);
    await expect(BrowserSession.use(refuse, (session) => session.printPdf(page), 5000)).rejects.toThrow('Printing failed');
    expect(alive(refuse)).toBe(false);
    const junk = fakeBrowser('junk', `const first = reply; reply = (m) => (m.method === 'Page.printToPDF' ? { data: Buffer.from('%PDF-1.4 cut off').toString('base64') } : first(m));`);
    await expect(BrowserSession.use(junk, (session) => session.printPdf(page), 5000)).rejects.toThrow('complete PDF');
    const missing = fakeBrowser('missing', `const first = reply; reply = (m) => (m.method === 'Page.navigate' ? { errorText: 'net::ERR_FILE_NOT_FOUND' } : first(m));`);
    await expect(BrowserSession.use(missing, (session) => session.printPdf(page), 5000)).rejects.toThrow('ERR_FILE_NOT_FOUND');
    const scriptError = fakeBrowser('script-error', `const first = reply; reply = (m) => (m.method === 'Runtime.evaluate' ? { exceptionDetails: { exception: { description: 'Error: The diagram renderer did not load.\\n at x' } } } : first(m));`);
    await expect(BrowserSession.use(scriptError, (session) => session.drawDiagrams(page, ['a']), 5000)).rejects.toThrow('The diagram renderer did not load.');
    await expect(BrowserSession.use(join(folder, 'no-such-browser'), (session) => session.printPdf(page), 5000)).rejects.toThrow('could not be started');
  });

  unix('stops the browser when the work itself fails, and leaves no profile behind', async () => {
    const browser = fakeBrowser('work-fails');
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('seamless-markdown-profile-')).length;
    await expect(
      BrowserSession.use(
        browser,
        async (session) => {
          await session.drawDiagrams(page, ['a']);
          throw new Error('disk full');
        },
        5000,
      ),
    ).rejects.toThrow('disk full');
    expect(alive(browser)).toBe(false);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('seamless-markdown-profile-')).length).toBe(before);
  });
});

describe('where the export commands are offered', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8'));
  const menus = pkg.contributes.menus as Record<string, { command: string; when?: string; group?: string }[]>;
  const entry = (menu: string, command: string) => menus[menu].find((item) => item.command === `seamlessMarkdown.${command}`);
  const anyMarkdown = "resourceLangId == markdown || activeCustomEditorId == 'seamlessMarkdown.editor'";

  it('in the Command Palette for any Markdown editor, not only this one', () => {
    expect(entry('commandPalette', 'exportHtml')?.when).toBe(anyMarkdown);
    expect(entry('commandPalette', 'copyAsHtml')?.when).toBe(anyMarkdown);
    expect(entry('commandPalette', 'exportPdf')?.when).toBe(`!seamlessMarkdown.pdfUnavailable && (${anyMarkdown})`);
  });

  it('in the Explorer context menu and the editor title menu', () => {
    for (const command of ['exportHtml', 'exportPdf']) {
      expect(entry('explorer/context', command)?.when).toContain('resourceLangId == markdown');
      expect(entry('editor/title', command)?.when).toContain(anyMarkdown);
      // Not in the "navigation" group: that would put a button in the title bar instead of an entry in the … menu.
      expect(entry('editor/title', command)?.group).toMatch(/^seamlessMarkdown\.export@\d$/);
    }
  });

  it('hides PDF export everywhere while no browser can print', () => {
    for (const menu of ['commandPalette', 'explorer/context', 'editor/title']) {
      expect(entry(menu, 'exportPdf')?.when, menu).toContain('!seamlessMarkdown.pdfUnavailable');
      expect(entry(menu, 'exportHtml')?.when, menu).not.toContain('pdfUnavailable');
    }
  });

  it('has no setting that makes an exported file load something, and keeps the browser path out of workspaces', () => {
    const settings = pkg.contributes.configuration.properties as Record<string, { scope?: string }>;
    expect(Object.keys(settings).filter((name) => name.startsWith('seamlessMarkdown.export.')).sort()).toEqual(['seamlessMarkdown.export.browserPath', 'seamlessMarkdown.export.embedImages']);
    expect(settings['seamlessMarkdown.export.browserPath'].scope).toBe('machine');
  });

  it('ships what an export reads at run time', () => {
    const shipped = readFileSync(join(__dirname, '../../.vscodeignore'), 'utf8').split('\n');
    for (const file of ['!dist/export.js', '!dist/mermaid.js', '!dist/katex.css', '!dist/fonts/*.woff2']) expect(shipped).toContain(file);
  });
});
