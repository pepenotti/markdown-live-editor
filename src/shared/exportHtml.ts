// Turns Markdown into HTML for "Copy as HTML" and for the HTML and PDF export.
// Pure code: nothing here touches VS Code or the file system.
import katex from 'katex';
import MarkdownIt, { type MarkdownIt as Markdown, type Token } from 'markdown-it';
import { EMAIL_WRAPPER, emailFootnotes, emailPlugin, type EmailState } from './emailHtml';
import { isLocalSource } from './embed';
import { exportCss } from './exportCss';
import { katexStyles } from './katexCss';
import { footnoteList, footnotePlugin, referenceAnchor } from './footnotePlugin';
import { escapeHtml, highlight } from './highlight';
import { FRONT_MATTER_NEXT } from './markdownSyntax';
import { mathPlugin } from './mathPlugin';
import { extractHeadings, headingPlainText, headingSlugs, slugify } from './textUtil';
import { type WikiHref, wikiLinkPlugin } from './wikiLinkPlugin';

export interface RenderOptions {
  /**
   * The Mermaid diagrams of the document, already drawn: one SVG per `mermaid` code block
   * in the order of `mermaidSources`, or null where a block could not be drawn. A block
   * without an SVG is exported as its source.
   */
  diagrams?: readonly (string | null)[];
  /**
   * The KaTeX style sheet and its fonts (by file name without extension, as base64). With
   * them math is rendered as KaTeX's HTML and `renderDocument` embeds the styles and the
   * fonts the formulas use. Without them math is MathML, which needs neither.
   */
  katex?: { css: string; font: (name: string) => string | undefined };
  /** Set by `renderEmail`: the output is for pasting into a mail, and this counts what had to be left out. */
  email?: EmailState;
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
  /** How many `mermaid` code blocks the document has, and how many of them were exported as drawings. */
  diagrams: number;
  diagramsDrawn: number;
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

/**
 * A formula as HTML. `styled` is for a document that carries the KaTeX style sheet: the
 * formula is then KaTeX's own layout (with MathML next to it for screen readers), which
 * looks the same in every browser and in print. Otherwise it is MathML only, which needs no
 * style sheet and no fonts but is drawn by the browser with whatever math font it has.
 */
export function renderMath(tex: string, display: boolean, styled = false): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: styled ? 'htmlAndMathml' : 'mathml' });
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

const isMermaid = (token: Token) => token.type === 'fence' && /^mermaid(?:\s|$)/i.test(token.info.trim());

const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i;

function build(): Markdown {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, language) => highlight(code, language) ?? '',
  });
  mathPlugin(md, (tex, display, env) => renderMath(tex, display, !!ours(env).options?.katex));
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
    if (isMermaid(token)) {
      const index = ours(env).diagrams++;
      const svg = ours(env).options.diagrams?.[index];
      // Mermaid's strict mode keeps scripts out of what it draws; this is the second lock on that door.
      if (svg && /^\s*<svg[\s>]/i.test(svg) && !/<script[\s>/]/i.test(svg)) {
        ours(env).diagramsDrawn++;
        return `<figure class="diagram">${svg}</figure>\n`;
      }
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
  // Last, because it wraps the rules above.
  emailPlugin(md, (env) => ours(env).options?.email);
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
    diagrams: 0,
    diagramsDrawn: 0,
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
  return { html: html + footnoteSection(md, env), title: env.title, diagrams: env.diagrams, diagramsDrawn: env.diagramsDrawn };
}

export interface EmailRendered {
  /** One element with inline styles on everything in it, for the `text/html` flavour of the clipboard. */
  html: string;
  /** Text of the first heading, or empty. */
  title: string;
  /** Local images and diagrams that a mail cannot carry and that were replaced by a note. */
  omittedImages: number;
  omittedDiagrams: number;
}

/**
 * Renders Markdown for pasting into an email: see src/shared/emailHtml.ts for what that means.
 * Wiki links are passed as for `renderMarkdown`; in a mail they should resolve to text.
 */
export function renderEmail(source: string, options: Pick<RenderOptions, 'wikiLinks'> = {}): EmailRendered {
  const body = stripFrontMatter(source);
  const email: EmailState = { images: 0, diagrams: 0 };
  const env = newEnv({ ...options, email }, source, body);
  const md = renderer();
  let html = md.render(body, env);
  const notes: { number: number; html: string }[] = [];
  // Rendering the text of a note can number further notes, so the list is read again each round.
  for (let i = 0; i < footnoteList(env).length; i++) {
    const note = footnoteList(env)[i];
    notes.push({ number: note.number, html: md.renderInline(note.text, env) });
  }
  html += emailFootnotes(notes);
  return { html: `<div style="${EMAIL_WRAPPER}">\n${html}</div>\n`, title: env.title, omittedImages: email.images, omittedDiagrams: email.diagrams };
}

/** The sources of the `mermaid` code blocks of a document, in the order they are rendered. */
export function mermaidSources(source: string): string[] {
  const found: string[] = [];
  const visit = (tokens: readonly Token[]) => {
    for (const token of tokens) if (isMermaid(token)) found.push(token.content);
  };
  visit(renderer().parse(stripFrontMatter(source), newEnv({})));
  return found;
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
}

/**
 * The policy of an exported file. The document's own HTML is passed through, but nothing in
 * it can run a script or load a frame, a style sheet or a font: there is no `script-src`,
 * and the export itself adds no script. Images and media the document itself refers to stay
 * as they are.
 */
export function contentSecurityPolicy(): string {
  return [`default-src 'none'`, `img-src * data: blob:`, `media-src * data: blob:`, `style-src 'unsafe-inline'`, `font-src data:`, `base-uri 'none'`, `form-action 'none'`].join('; ');
}

/** A complete, self-contained HTML document. */
export function renderDocument(source: string, options: DocumentOptions = {}): Rendered {
  const body = renderMarkdown(source, options);
  const title = body.title || options.fallbackTitle || 'Untitled';
  const math = options.katex ? katexStyles(body.html, options.katex.css, options.katex.font) : '';
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy()}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Seamless Markdown">
<title>${escapeHtml(title)}</title>
<style>
${exportCss(options.print === true)}${math ? `${math}\n` : ''}</style>
</head>
<body>
<main class="markdown-body">
${body.html}</main>
</body>
</html>
`;
  return { ...body, html, title };
}
