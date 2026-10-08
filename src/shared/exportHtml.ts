// Turns Markdown into HTML for "Copy as HTML" and for the HTML and PDF export.
// Pure code: nothing here touches VS Code or the file system.
import katex from 'katex';
import MarkdownIt, { type MarkdownIt as Markdown, type Token } from 'markdown-it';
import { exportCss } from './exportCss';
import { escapeHtml, highlight } from './highlight';
import { mathPlugin } from './mathPlugin';
import { slugify } from './textUtil';

/** Major version of Mermaid loaded from the CDN; kept equal to the one the editor bundles. */
export const MERMAID_CDN_MAJOR = 12;
export const MERMAID_CDN_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_MAJOR}/dist/mermaid.esm.min.mjs`;

export interface RenderOptions {
  /** Emit `mermaid` code blocks as `<pre class="mermaid">` for the Mermaid script instead of as code. */
  mermaid?: boolean;
  /** Replacement URLs for image sources, keyed by the source as it appears in the rendered HTML. */
  images?: ReadonlyMap<string, string>;
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
  [key: string | symbol]: unknown;
}
const ours = (env: unknown) => env as Env;

/** An attribute of a token as text. */
function attr(token: Token, name: string): string {
  const value = token.attrGet(name);
  return value === null || value === undefined ? '' : String(value);
}

const FRONT_MATTER_NEXT = /^\s*(?:[A-Za-z_][\w .-]*:|#|-\s|---\s*$|\.\.\.\s*$)/;

/** Removes a closed YAML front matter block from the start of a document (same rule as the editor). */
export function stripFrontMatter(text: string): string {
  const first = /^---[ \t]*\r?\n/.exec(text);
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
  return text;
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

function build(): Markdown {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    highlight: (code, language) => highlight(code, language) ?? '',
  });
  mathPlugin(md, renderMath);

  // GitHub-style ids on headings, so links such as [x](#some-heading) work.
  md.core.ruler.push('heading_ids', (state) => {
    const env = ours(state.env);
    const used = new Set<string>();
    state.tokens.forEach((token, i) => {
      if (token.type !== 'heading_open') return;
      const text = plainText(state.tokens[i + 1]).trim();
      if (!env.title) env.title = text;
      const slug = slugify(text);
      if (!slug) return;
      let id = slug;
      for (let n = 1; used.has(id); n++) id = `${slug}-${n}`;
      used.add(id);
      token.attrSet('id', id);
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
const newEnv = (options: RenderOptions): Env => ({ options, html: '', title: '', hasMermaid: false });

/** Renders Markdown to an HTML fragment. Raw HTML in the document is passed through. */
export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const env = newEnv(options);
  const html = renderer().render(stripFrontMatter(source), env);
  return { html, title: env.title, hasMermaid: env.hasMermaid };
}

/** True for an image source that names a file rather than a URL. */
export function isLocalSource(src: string): boolean {
  const s = src.trim();
  return s !== '' && !s.startsWith('#') && !s.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(s);
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
  visit(renderer().parse(stripFrontMatter(source), newEnv({})));
  return [...found];
}

/** File path an image source points at: relative to the document, or to the project when it starts with a slash. */
export function sourceToPath(src: string): string {
  const path = src.trim().replace(/[?#].*$/, '');
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

export function imageMime(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext && Object.hasOwn(MIME, ext) ? MIME[ext] : undefined;
}

export interface DocumentOptions extends RenderOptions {
  /** Used when the document has no heading. */
  fallbackTitle?: string;
  /** For printing: no dark colours. */
  print?: boolean;
}

function mermaidScript(print: boolean): string {
  const theme = print ? `'default'` : `matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default'`;
  return `<script type="module">
import mermaid from '${MERMAID_CDN_URL}';
mermaid.initialize({ startOnLoad: false, theme: ${theme} });
await mermaid.run({ querySelector: 'pre.mermaid' });
</script>\n`;
}

/** A complete, self-contained HTML document. */
export function renderDocument(source: string, options: DocumentOptions = {}): Rendered {
  const body = renderMarkdown(source, options);
  const title = body.title || options.fallbackTitle || 'Untitled';
  const script = body.hasMermaid && options.mermaid ? mermaidScript(options.print === true) : '';
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Seamless Markdown">
<title>${escapeHtml(title)}</title>
<style>
${exportCss(options.print === true)}</style>
</head>
<body>
<main class="markdown-body">
${body.html}</main>
${script}</body>
</html>
`;
  return { html, title, hasMermaid: body.hasMermaid };
}
