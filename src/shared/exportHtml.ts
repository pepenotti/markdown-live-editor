// Turns Markdown into HTML for "Copy as HTML" and for the HTML and PDF export.
// Pure code: nothing here touches VS Code or the file system.
import katex from 'katex';
import MarkdownIt, { type MarkdownIt as Markdown, type Token } from 'markdown-it';
import { isLocalSource } from './embed';
import { exportCss } from './exportCss';
import { footnoteList, footnotePlugin, referenceAnchor } from './footnotePlugin';
import { escapeHtml, highlight } from './highlight';
import { FRONT_MATTER_NEXT } from './markdownSyntax';
import { mathPlugin } from './mathPlugin';
import { extractHeadings, headingPlainText, headingSlugs, slugify } from './textUtil';
import { type WikiHref, wikiLinkPlugin } from './wikiLinkPlugin';

/** Major version of Mermaid loaded from the CDN; kept equal to the one the editor bundles. */
export const MERMAID_CDN_MAJOR = 12;
/** Everything Mermaid loads comes from this folder; the content security policy allows nothing else. */
export const MERMAID_CDN_BASE = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_MAJOR}/`;
export const MERMAID_CDN_URL = `${MERMAID_CDN_BASE}dist/mermaid.esm.min.mjs`;

export interface RenderOptions {
  /** Emit `mermaid` code blocks as `<pre class="mermaid">` for the Mermaid script instead of as code. */
  mermaid?: boolean;
  /** Replacement URLs for image sources, keyed by the source as it appears in the rendered HTML. */
  images?: ReadonlyMap<string, string>;
  /**
   * Given only while wiki links are turned on: `[[Note]]` is then a link to the URL this
   * returns for the note, or just its text when it returns null. Left out, double brackets
   * are rendered like any other text.
   */
  wikiLinks?: WikiHref;
}

export interface Rendered {
  /** The body of the document, or the whole document for `renderDocument`. */
  html: string;
  /** Text of the first heading, or empty. */
  title: string;
  hasMermaid: boolean;
}

interface Env extends Rendered {
  options: RenderOptions;
  /** Anchor of each heading the editor knows, by its line in the rendered text. */
  slugByLine: Map<number, string>;
  /** Every anchor given so far. */
  usedSlugs: Set<string>;
  [key: string | symbol]: unknown;
}
const ours = (env: unknown) => env as Env;

/** An attribute of a token as text. */
function attr(token: Token, name: string): string {
  const value = token.attrGet(name);
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Removes the YAML front matter block from the start of a document, by the rule of the
 * editor: a block that is never closed runs to the end of the document.
 */
export function stripFrontMatter(text: string): string {
  const first = /^---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!first) return text;
  let pos = first[0].length;
  const lineAt = (from: number) => {
    const end = text.indexOf('\n', from);
    return end === -1 ? { line: text.slice(from), next: text.length } : { line: text.slice(from, end).replace(/\r$/, ''), next: end + 1 };
  };
  if (!FRONT_MATTER_NEXT.test(lineAt(pos).line)) return text;
  while (pos < text.length) {
    const { line, next } = lineAt(pos);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line)) return text.slice(next);
    pos = next;
  }
  return '';
}

/** MathML only: it needs no style sheet and no fonts, so the output stays self-contained. */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'mathml' });
  } catch (err) {
    return `<code class="katex-error">${escapeHtml(err instanceof Error ? err.message : String(err))}</code>`;
  }
}

/** The text of a heading as a reader sees it. */
function plainText(inline: Token | undefined): string {
  let out = '';
  for (const child of inline?.children ?? []) {
    if (child.type === 'softbreak' || child.type === 'hardbreak') out += ' ';
    else if (child.type !== 'html_inline') out += child.content;
  }
  return out;
}

const IMG_SRC = /(<img\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

function swapHtmlImages(html: string, images: ReadonlyMap<string, string> | undefined): string {
  if (!images?.size) return html;
  return html.replace(IMG_SRC, (all, head: string, a?: string, b?: string) => {
    const to = images.get(a ?? b ?? '');
    return to === undefined ? all : `${head}"${escapeHtml(to)}"`;
  });
}

const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i;

function build(): Markdown {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, language) => highlight(code, language) ?? '',
  });
  mathPlugin(md, renderMath);
  footnotePlugin(md);
  wikiLinkPlugin(md, (env) => ours(env).options?.wikiLinks);

  // Ids on headings, so links such as [x](#some-heading) and a table of contents work.
  // The anchors are the ones the rest of the extension uses (`headingSlugs`), matched by line.
  md.core.ruler.push('heading_ids', (state) => {
    const env = ours(state.env);
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return;
      const inline = state.tokens[i + 1];
      if (!env.title) env.title = plainText(inline).trim();
      let id = token.map ? env.slugByLine.get(token.map[0]) : undefined;
      if (id === undefined) {
        // A heading the line scan does not know (underlined, or inside a quote or list).
        const base = slugify(headingPlainText(inline?.content ?? ''));
        id = base;
        for (let n = 1; id && env.usedSlugs.has(id); n++) id = `${base}-${n}`;
        env.usedSlugs.add(id);
      }
      if (id) token.attrSet('id', id);
    });
  });

  // "- [ ] task" and "- [x] task" become disabled checkboxes.
  md.core.ruler.push('task_lists', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const item = tokens[i - 2];
      if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || item.type !== 'list_item_open') continue;
      const children = tokens[i].children ?? [];
      const first = children[0];
      const mark = first?.type === 'text' ? /^\[([ xX])\][ \t]+(?=\S)/.exec(first.content) : null;
      if (!first || !mark) continue;
      first.content = first.content.slice(mark[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input type="checkbox" disabled${mark[1] === ' ' ? '' : ' checked'}> `;
      children.unshift(box);
      item.attrJoin('class', 'task-list-item');
      for (let j = i - 3; j >= 0; j--) {
        const list = tokens[j];
        if (list.level === item.level - 1 && (list.type === 'bullet_list_open' || list.type === 'ordered_list_open')) {
          if (!/\bcontains-task-list\b/.test(attr(list, 'class'))) list.attrJoin('class', 'contains-task-list');
          break;
        }
      }
    }
  });

  // GitHub alerts: a quote whose first line is "[!NOTE]", "[!TIP]", "[!IMPORTANT]", "[!WARNING]" or "[!CAUTION]".
  md.core.ruler.push('alerts', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const quote = tokens[i - 2];
      if (tokens[i].type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || quote.type !== 'blockquote_open') continue;
      const children = tokens[i].children ?? [];
      const first = children[0];
      const kind = first?.type === 'text' ? ALERT.exec(first.content.trim())?.[1].toLowerCase() : undefined;
      // The label has its line to itself.
      if (!first || !kind || (children[1] && children[1].type !== 'softbreak' && children[1].type !== 'hardbreak')) continue;
      quote.attrJoin('class', `alert alert-${kind}`);
      const label = new state.Token('html_inline', '', 0);
      label.content = `<strong class="alert-title">${kind[0].toUpperCase()}${kind.slice(1)}</strong>`;
      children[0] = label;
      if (children[1]) {
        children[1].type = 'hardbreak';
        children[1].tag = 'br';
      }
    }
  });

  const rules = md.renderer.rules;
  const fence = rules.fence!;
  rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (/^mermaid(?:\s|$)/i.test(token.info.trim())) {
      ours(env).hasMermaid = true;
      if (ours(env).options.mermaid) return `<pre class="mermaid">${escapeHtml(token.content)}</pre>\n`;
    }
    return fence(tokens, idx, options, env, self);
  };

  const image = rules.image!;
  rules.image = (tokens, idx, options, env, self) => {
    const to = ours(env).options.images?.get(attr(tokens[idx], 'src'));
    if (to !== undefined) tokens[idx].attrSet('src', to);
    return image(tokens, idx, options, env, self);
  };
  // The checkbox of a task list is an html_inline token too; it has no image and passes through.
  rules.html_block = (tokens, idx, _options, env) => swapHtmlImages(tokens[idx].content, ours(env).options.images);
  rules.html_inline = (tokens, idx, _options, env) => swapHtmlImages(tokens[idx].content, ours(env).options.images);
  return md;
}

let shared: Markdown | undefined;
const renderer = () => (shared ??= build());

/** `body` is `source` without its front matter. */
function newEnv(options: RenderOptions, source = '', body = ''): Env {
  // Lines of the body are lines of the source moved up by the front matter.
  const offset = source.length === body.length ? 0 : source.slice(0, source.length - body.length).split('\n').length - 1;
  const headings = body ? extractHeadings(source) : [];
  const slugs = headingSlugs(headings);
  return {
    options,
    html: '',
    title: '',
    hasMermaid: false,
    slugByLine: new Map(headings.map((h, i) => [h.line - offset, slugs[i]])),
    usedSlugs: new Set(slugs),
  };
}

/** The notes at the end of the document, each with a link back to where it is referenced. */
function footnoteSection(md: Markdown, env: Env): string {
  let items = '';
  // Rendering the text of a note can number further notes, so the list is read again each round.
  for (let i = 0; i < footnoteList(env).length; i++) {
    const note = footnoteList(env)[i];
    const text = md.renderInline(note.text, env);
    const back = `<a href="#${referenceAnchor(note.number, 1)}" class="footnote-back" aria-label="Back to the text">↩</a>`;
    items += `<li id="fn-${note.number}">${text}${note.uses ? ` ${back}` : ''}</li>\n`;
  }
  return items ? `<section class="footnotes">\n<ol>\n${items}</ol>\n</section>\n` : '';
}

/** Renders Markdown to an HTML fragment. Raw HTML in the document is passed through. */
export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const body = stripFrontMatter(source);
  const env = newEnv(options, source, body);
  const md = renderer();
  const html = md.render(body, env);
  return { html: html + footnoteSection(md, env), title: env.title, hasMermaid: env.hasMermaid };
}

/** Sources of the local images of a document, as they appear in the rendered HTML, without repeats. */
export function localImageSources(source: string): string[] {
  const found = new Set<string>();
  const add = (src: string | null | undefined) => {
    if (src && isLocalSource(src)) found.add(src);
  };
  const visit = (tokens: readonly Token[]) => {
    for (const token of tokens) {
      if (token.type === 'image') add(attr(token, 'src'));
      else if (token.type === 'html_block' || token.type === 'html_inline') {
        for (const m of token.content.matchAll(IMG_SRC)) add((m[2] ?? m[3]) as string | undefined);
      }
      if (token.children) visit(token.children);
    }
  };
  const md = renderer();
  const env = newEnv({});
  visit(md.parse(stripFrontMatter(source), env));
  // Images in the text of footnotes.
  for (const note of footnoteList(env)) visit(md.parseInline(note.text, newEnv({})));
  return [...found];
}

export interface DocumentOptions extends RenderOptions {
  /** Used when the document has no heading. */
  fallbackTitle?: string;
  /** For printing: no dark colours. */
  print?: boolean;
  /** Value that marks the Mermaid script as the export's own. Random unless given. */
  nonce?: string;
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The policy of an exported file. The document's own HTML is passed through, but nothing in
 * it can run a script or load a frame, a style sheet or a font. Images and media the
 * document itself refers to stay as they are. With `mermaidNonce`, the one script the
 * export adds may run and load Mermaid from its CDN folder; without it no script runs at all.
 */
export function contentSecurityPolicy(mermaidNonce?: string): string {
  return [
    `default-src 'none'`,
    `img-src * data: blob:`,
    `media-src * data: blob:`,
    `style-src 'unsafe-inline'`,
    `font-src data:`,
    `base-uri 'none'`,
    `form-action 'none'`,
    ...(mermaidNonce ? [`script-src 'nonce-${mermaidNonce}' ${MERMAID_CDN_BASE}`] : []),
  ].join('; ');
}

function mermaidScript(print: boolean, nonce: string): string {
  const theme = print ? `'default'` : `matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'`;
  return `<script type="module" nonce="${nonce}">
import mermaid from '${MERMAID_CDN_URL}';
mermaid.initialize({ startOnLoad: false, theme: ${theme} });
await mermaid.run({ querySelector: 'pre.mermaid' });
</script>\n`;
}

/** A complete, self-contained HTML document. */
export function renderDocument(source: string, options: DocumentOptions = {}): Rendered {
  const body = renderMarkdown(source, options);
  const title = body.title || options.fallbackTitle || 'Untitled';
  const nonce = body.hasMermaid && options.mermaid ? (options.nonce ?? randomNonce()).replace(/[^A-Za-z0-9+/=_-]/g, '') : undefined;
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Seamless Markdown">
<title>${escapeHtml(title)}</title>
<style>
${exportCss(options.print === true)}</style>
</head>
<body>
<main class="markdown-body">
${body.html}</main>
${nonce ? mermaidScript(options.print === true, nonce) : ''}</body>
</html>
`;
  return { html, title, hasMermaid: body.hasMermaid };
}
