// Turns clipboard HTML into Markdown. No editor dependencies.
//
// The HTML is untrusted. It is parsed into an inert document with DOMParser and only
// read from: nothing is inserted into the page, no script runs and nothing is loaded.
// Scripts, styles and form controls are dropped, event handler attributes are never
// read, and URLs with a scheme outside a short allow-list are discarded.
import { type Align, serializeTable } from './table/model';

/** The part of a DOM node the converter reads. A real `Node` fits, and so does a hand-built tree. */
export interface HtmlNode {
  readonly nodeType: number;
  readonly nodeName: string;
  readonly nodeValue: string | null;
  readonly childNodes: ArrayLike<HtmlNode>;
  getAttribute?(name: string): string | null;
}

export interface Conversion {
  markdown: string;
  /** False when the HTML held nothing but plain text, so the plain clipboard text is just as good. */
  rich: boolean;
  /** True when the result has to start on a line of its own: more than one block, or a heading, list, table… */
  block: boolean;
}

interface Marks {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: { href: string } | null;
}

interface Run extends Marks {
  kind: 'text' | 'raw' | 'br';
  text: string;
}

interface Block {
  kind: 'p' | 'list' | 'other';
  text: string;
}

interface Item {
  blocks: Block[];
  /** Checked state of a task item, null for an ordinary one. */
  task: boolean | null;
}

interface Context {
  rich: boolean;
  /** Nodes already accounted for, such as the checkbox of a task item. */
  skip: Set<HtmlNode>;
  /** Inside a table cell a line cannot start a block, so its first character needs no escape. */
  cell: boolean;
}

const NO_MARKS: Marks = { bold: false, italic: false, strike: false, code: false, link: null };

/** Stands for a hard line break until the block that holds it decides how to write it. */
const BR = '\0';

const DROPPED = new Set([
  'script', 'style', 'meta', 'link', 'head', 'title', 'base', 'noscript', 'template', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'map', 'area',
  'select', 'option', 'datalist', 'textarea', 'button', 'input', 'colgroup', 'col', 'caption', 'xml',
]);

const BLOCKS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'html', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'ul',
]);

const MONOSPACE = /\b(?:monospace|courier|consolas|menlo|monaco)\b|\bmono\b/i;
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel', 'ftp']);
const IMAGE_SCHEMES = new Set(['http', 'https']);

/* ---------- reading nodes ---------- */

function tagOf(node: HtmlNode): string {
  return node.nodeType === 1 ? node.nodeName.toLowerCase() : '';
}

function attr(node: HtmlNode, name: string): string {
  return node.getAttribute?.(name) ?? '';
}

function kids(node: HtmlNode): HtmlNode[] {
  return Array.from(node.childNodes);
}

const styles = new WeakMap<HtmlNode, Map<string, string>>();

function styleOf(node: HtmlNode): Map<string, string> {
  let map = styles.get(node);
  if (map) return map;
  map = new Map();
  for (const part of attr(node, 'style').split(';')) {
    const colon = part.indexOf(':');
    if (colon > 0) map.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().toLowerCase());
  }
  styles.set(node, map);
  return map;
}

/** Word puts the bullet or number of a list paragraph in a span marked this way. */
function isWordListMarker(node: HtmlNode): boolean {
  return styleOf(node).get('mso-list') === 'ignore';
}

function isDropped(node: HtmlNode, cx: Context): boolean {
  if (node.nodeType !== 1) return node.nodeType !== 3;
  const tag = tagOf(node);
  if (DROPPED.has(tag) || cx.skip.has(node)) return true;
  if (node.getAttribute?.('hidden') != null) return true;
  const style = styleOf(node);
  return style.get('display') === 'none' || isWordListMarker(node);
}

const blockInside = new WeakMap<HtmlNode, boolean>();

/** An inline element that wraps blocks (Google Docs wraps everything in a `<b>`) is treated as a container. */
function isBlockLike(node: HtmlNode): boolean {
  if (node.nodeType !== 1) return false;
  const tag = tagOf(node);
  if (DROPPED.has(tag)) return false;
  if (BLOCKS.has(tag)) return true;
  let known = blockInside.get(node);
  if (known === undefined) {
    known = kids(node).some(isBlockLike);
    blockInside.set(node, known);
  }
  return known;
}

function textOf(node: HtmlNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? '';
  if (node.nodeType !== 1 || DROPPED.has(tagOf(node))) return '';
  if (tagOf(node) === 'br') return '\n';
  return kids(node).map(textOf).join('');
}

function isBlankText(node: HtmlNode): boolean {
  return node.nodeType === 3 && cleanText(node.nodeValue ?? '').trim() === '';
}

/** Collapses white space the way HTML rendering does. Non-breaking and zero-width spaces are editor noise. */
function cleanText(text: string): string {
  return text.replace(/[​﻿\0]/g, '').replace(/[\s ]+/g, ' ');
}

/** A URL that is safe to write into the document, or null. Relative URLs pass. */
function safeUrl(raw: string, schemes: Set<string>): string | null {
  // Browsers ignore control characters and white space inside a scheme, so "java\tscript:" must not slip through.
  const url = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (url === '') return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (scheme && !schemes.has(scheme[1].toLowerCase())) return null;
  return url;
}

/** Writes a URL so that it survives as a link destination. */
function destination(url: string): string {
  let out = url.replace(/\s/g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\\/g, '%5C');
  let depth = 0;
  let balanced = true;
  for (const ch of out) {
    if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) balanced = false;
  }
  if (!balanced || depth !== 0) out = out.replace(/\(/g, '%28').replace(/\)/g, '%29');
  return out;
}

/* ---------- escaping ---------- */

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/** Escapes the characters of plain text that would otherwise be read as Markdown, and only those. */
export function escapeText(text: string, inLink = false): string {
  let out = '';
  // Looked up once, so that a long run of brackets or dollar signs is not rescanned for each of them.
  const lastBracket = text.lastIndexOf(']');
  let lastDollar = -1;
  for (let j = text.length - 1; j > 0 && lastDollar < 0; j--) if (text[j] === '$' && !/\s/.test(text[j - 1])) lastDollar = j;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1] ?? '';
    const next = text[i + 1] ?? '';
    let escape = false;
    switch (ch) {
      case '\\':
        escape = next === '' || PUNCTUATION.test(next);
        break;
      case '`':
        escape = true;
        break;
      case '*':
        // A star with white space on both sides cannot open or close emphasis.
        escape = !(/\s/.test(prev) && /\s/.test(next));
        break;
      case '_':
        // An underscore inside a word (snake_case) is literal already.
        escape = !(WORD.test(prev) && WORD.test(next));
        break;
      case '[':
        escape = inLink || lastBracket > i;
        break;
      case ']':
        escape = inLink;
        break;
      case '<':
        escape = /[a-z/!?]/i.test(next);
        break;
      case '&':
        escape = /^&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(text.slice(i, i + 40));
        break;
      case '~':
        escape = prev === '~' || next === '~';
        break;
      case '$':
        // This editor reads `$x$` as math, unless a space follows the opening or precedes the closing dollar.
        escape = next !== '' && !/\s/.test(next) && lastDollar > i + 1;
        break;
    }
    out += escape ? '\\' + ch : ch;
  }
  return out;
}

/** Escapes a line of a paragraph whose first characters would start another kind of block. */
function escapeLineStart(line: string): string {
  if (/^(?:#{1,6}(?:\s|$)|>|[-+](?:\s|$)|(?:-\s*){3,}$|=+\s*$)/.test(line)) return '\\' + line;
  // After a line with a pipe in it, a row of dashes and pipes would turn both into a table.
  if (line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line)) return '\\' + line;
  const ordered = /^(\d{1,9})[.)](?:\s|$)/.exec(line);
  if (ordered) return ordered[1] + '\\' + line.slice(ordered[1].length);
  return line;
}

function codeSpan(text: string): string {
  if (text.trim() === '') return text;
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ')) ? ' ' : '';
  return fence + pad + text + pad + fence;
}

/* ---------- inline content ---------- */

function marksFor(node: HtmlNode, inherited: Marks): Marks {
  const marks = { ...inherited };
  const tag = tagOf(node);
  if (tag === 'b' || tag === 'strong') marks.bold = true;
  else if (tag === 'i' || tag === 'em') marks.italic = true;
  else if (tag === 's' || tag === 'strike' || tag === 'del') marks.strike = true;
  else if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') marks.code = true;
  else if (tag === 'a') {
    const href = safeUrl(attr(node, 'href'), LINK_SCHEMES);
    if (href) marks.link = { href };
  }
  // Google Docs and Word express formatting as styles, and Docs wraps a whole copy in <b style="font-weight:normal">.
  const style = styleOf(node);
  const weight = style.get('font-weight');
  if (weight) {
    const n = Number.parseInt(weight, 10);
    if (weight === 'bold' || weight === 'bolder' || n >= 600) marks.bold = true;
    else if (weight === 'normal' || weight === 'lighter' || n <= 500) marks.bold = false;
  }
  const slant = style.get('font-style');
  if (slant === 'italic' || slant?.startsWith('oblique')) marks.italic = true;
  else if (slant === 'normal') marks.italic = false;
  if (`${style.get('text-decoration') ?? ''} ${style.get('text-decoration-line') ?? ''}`.includes('line-through')) marks.strike = true;
  if ((tag === 'span' || tag === 'font') && MONOSPACE.test(`${style.get('font-family') ?? ''} ${attr(node, 'face')}`)) marks.code = true;
  return marks;
}

function collectInline(node: HtmlNode, marks: Marks, out: Run[], cx: Context): void {
  if (node.nodeType === 3) {
    const text = cleanText(node.nodeValue ?? '');
    if (text) out.push({ ...marks, kind: 'text', text });
    return;
  }
  if (isDropped(node, cx)) return;
  const tag = tagOf(node);
  if (tag === 'br') {
    out.push({ ...marks, code: false, kind: 'br', text: BR });
    return;
  }
  if (tag === 'img') {
    const src = safeUrl(attr(node, 'src'), IMAGE_SCHEMES);
    if (!src) return;
    const alt = cleanText(attr(node, 'alt')).trim().replace(/[\\[\]]/g, '\\$&');
    out.push({ ...marks, code: false, kind: 'raw', text: `![${alt}](${destination(src)})` });
    return;
  }
  const inner = marksFor(node, marks);
  // Blocks met while gathering a single line (a heading, say) are kept apart by a space.
  const spaced = BLOCKS.has(tag);
  if (spaced) out.push({ ...marks, kind: 'text', text: ' ' });
  for (const child of kids(node)) collectInline(child, inner, out, cx);
  if (spaced) out.push({ ...marks, kind: 'text', text: ' ' });
}

function sameMarks(a: Run, b: Run): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;
}

/** Drops the white space HTML would not show, and joins neighbours that carry the same formatting. */
function tidy(runs: Run[]): Run[] {
  const out: Run[] = [];
  const trimEnd = () => {
    for (let last = out[out.length - 1]; last && last.kind === 'text'; last = out[out.length - 1]) {
      last.text = last.text.replace(/ +$/, '');
      if (last.text) break;
      out.pop();
    }
  };
  let afterSpace = true;
  for (const run of runs) {
    if (run.kind === 'br') {
      trimEnd();
      out.push({ ...run });
      afterSpace = true;
      continue;
    }
    let text = run.text;
    if (run.kind === 'text') {
      if (afterSpace) text = text.replace(/^ +/, '');
      if (!text) continue;
      afterSpace = text.endsWith(' ');
    } else {
      afterSpace = false;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'text' && run.kind === 'text' && sameMarks(last, run)) last.text += text;
    else out.push({ ...run, text });
  }
  trimEnd();
  while (out.length && out[out.length - 1].kind === 'br') {
    out.pop();
    trimEnd();
  }
  while (out.length && out[0].kind === 'br') out.shift();
  return out;
}

/** Splits off leading and trailing white space: `<b> a </b>` is ` **a** `, never `** a **`. */
function edges(text: string): [string, string, string] {
  const blank = (ch: string) => ch === BR || /\s/.test(ch);
  let start = 0;
  let end = text.length;
  while (start < end && blank(text[start])) start++;
  while (end > start && blank(text[end - 1])) end--;
  return [text.slice(0, start), text.slice(start, end), text.slice(end)];
}

const LEVELS = ['link', 'strike', 'bold', 'italic', 'code'] as const;

/** Writes the formatting of the runs as nested Markdown, one kind of mark per level. */
function renderRuns(runs: Run[], level: number, cx: Context): string {
  if (level === LEVELS.length) return runs.map((r) => (r.kind === 'text' ? escapeText(r.text, r.link !== null) : r.text)).join('');
  const key = LEVELS[level];
  let out = '';
  for (let i = 0; i < runs.length; ) {
    let j = i + 1;
    while (j < runs.length && runs[j][key] === runs[i][key]) j++;
    const group = runs.slice(i, j);
    const value = runs[i][key];
    i = j;
    if (!value) {
      out += renderRuns(group, level + 1, cx);
      continue;
    }
    const code = key === 'code';
    const [lead, core, trail] = edges(code ? group.map((r) => r.text).join('') : renderRuns(group, level + 1, cx));
    if (!core) {
      out += lead;
      continue;
    }
    cx.rich = true;
    let body: string;
    if (code) {
      body = codeSpan(core);
    } else if (key === 'link') {
      const href = (value as { href: string }).href;
      const plain = group.every((r) => r.kind === 'text' && !r.bold && !r.italic && !r.strike && !r.code);
      const label = group.map((r) => r.text).join('').trim();
      body = plain && label === href && /^(?:https?|mailto|ftp):[^\s<>]*$/i.test(href) ? `<${href}>` : `[${core}](${destination(href)})`;
    } else {
      const mark = key === 'bold' ? '**' : key === 'italic' ? '*' : '~~';
      body = mark + core + mark;
    }
    out += lead + body + trail;
  }
  return out;
}

/** Renders gathered runs as one line of inline Markdown, with `BR` standing where the hard breaks are. */
function renderInline(runs: Run[], cx: Context): string {
  const tidied = tidy(runs);
  if (tidied.some((r) => r.kind === 'raw')) cx.rich = true;
  return renderRuns(tidied, 0, cx);
}

/** Splits runs into paragraphs at two or more consecutive line breaks and renders each. */
function paragraphs(runs: Run[], cx: Context): string[] {
  const parts: Run[][] = [[]];
  const tidied = tidy(runs);
  for (let i = 0; i < tidied.length; i++) {
    if (tidied[i].kind === 'br' && tidied[i + 1]?.kind === 'br') {
      while (tidied[i + 1]?.kind === 'br') i++;
      parts.push([]);
    } else {
      parts[parts.length - 1].push(tidied[i]);
    }
  }
  const out: string[] = [];
  for (const part of parts) {
    const line = renderInline(part, cx);
    if (line.trim() === '') continue;
    const lines = line.split(BR).map((l) => l.trim());
    out.push((cx.cell ? lines : lines.map(escapeLineStart)).join('\\\n'));
  }
  return out;
}

/* ---------- blocks ---------- */

function join(blocks: Block[]): string {
  return blocks.map((b) => b.text).join('\n\n');
}

/** Converts the children of a container, turning stretches of inline content into paragraphs. */
function blocksOf(parent: HtmlNode, cx: Context, marks: Marks = NO_MARKS): Block[] {
  const out: Block[] = [];
  let runs: Run[] = [];
  const flush = () => {
    for (const text of paragraphs(runs, cx)) out.push({ kind: 'p', text });
    runs = [];
  };
  const children = kids(parent);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (isBlockLike(child) && !isDropped(child, cx)) {
      flush();
      i = block(children, i, parent, out, cx, marks);
    } else {
      collectInline(child, marks, runs, cx);
    }
  }
  flush();
  return out;
}

/** Converts the block at `children[i]`. Returns the index of the last sibling it used. */
function block(children: HtmlNode[], i: number, parent: HtmlNode, out: Block[], cx: Context, marks: Marks): number {
  const node = children[i];
  const tag = tagOf(node);
  const heading = /^h([1-6])$/.exec(tag);
  if (heading) {
    const runs: Run[] = [];
    for (const child of kids(node)) collectInline(child, marks, runs, cx);
    // A heading is bold already.
    const text = renderInline(runs.map((r) => ({ ...r, bold: false })), cx)
      .split(BR)
      .join(' ')
      .replace(/ {2,}/g, ' ')
      .trim()
      // Hashes at the end, after a space, would be dropped as the closing of the heading.
      .replace(/(^| )(#+)$/, '$1\\$2');
    if (text) {
      cx.rich = true;
      out.push({ kind: 'other', text: '#'.repeat(Number(heading[1])) + ' ' + text });
    }
    return i;
  }
  switch (tag) {
    case 'ul':
    case 'ol': {
      const text = list(node, cx, marks);
      if (text) out.push({ kind: 'list', text });
      return i;
    }
    case 'li': {
      const text = renderList([itemOf(node, cx, marks)], false, 1, cx);
      if (text) out.push({ kind: 'list', text });
      return i;
    }
    case 'blockquote': {
      const inner = join(blocksOf(node, cx, marks));
      if (inner) {
        cx.rich = true;
        out.push({ kind: 'other', text: prefixLines(inner, '> ', '> ') });
      }
      return i;
    }
    case 'pre': {
      const text = codeBlock(node, parent);
      if (text) {
        cx.rich = true;
        out.push({ kind: 'other', text });
      }
      return i;
    }
    case 'hr':
      cx.rich = true;
      out.push({ kind: 'other', text: '---' });
      return i;
    case 'table':
      table(node, out, cx, marks);
      return i;
  }
  if (wordListLevel(node) > 0) return wordList(children, i, out, cx, marks);
  out.push(...blocksOf(node, cx, marksFor(node, marks)));
  return i;
}

function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => ((i === 0 ? first : rest) + line).trimEnd())
    .join('\n');
}

function codeBlock(pre: HtmlNode, parent: HtmlNode): string {
  const text = textOf(pre).replace(/\r\n?/g, '\n').replace(/\n$/, '');
  if (text.trim() === '') return '';
  const code = kids(pre).find((k) => tagOf(k) === 'code');
  const classes = [attr(pre, 'class'), code ? attr(code, 'class') : ''].join(' ');
  // GitHub wraps a highlighted block in <div class="highlight highlight-source-js">.
  const language = /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(classes)?.[1] ?? /(?:^|\s)highlight-source-([\w+#-]+)/.exec(attr(parent, 'class'))?.[1] ?? '';
  let longest = 2;
  for (const m of text.matchAll(/^[ \t]*(`+)/gm)) longest = Math.max(longest, m[1].length);
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

/* ---------- lists ---------- */

/** Finds the checkbox that makes a list item a task: the first thing in it, possibly inside a paragraph or label. */
function taskBox(item: HtmlNode): HtmlNode | null {
  let node = item;
  for (let depth = 0; depth < 4; depth++) {
    const first = kids(node).find((k) => k.nodeType === 1 || (k.nodeType === 3 && !isBlankText(k)));
    if (!first || first.nodeType !== 1) return null;
    const tag = tagOf(first);
    if (tag === 'input') return attr(first, 'type').toLowerCase() === 'checkbox' ? first : null;
    if (tag !== 'p' && tag !== 'span' && tag !== 'label' && tag !== 'div') return null;
    node = first;
  }
  return null;
}

function itemOf(node: HtmlNode, cx: Context, marks: Marks): Item {
  let task: boolean | null = null;
  const box = taskBox(node);
  if (box) {
    task = box.getAttribute?.('checked') != null;
    cx.skip.add(box);
  } else if (attr(node, 'role') === 'checkbox') {
    // Google Docs checklists.
    task = attr(node, 'aria-checked') === 'true';
  }
  return { blocks: blocksOf(node, cx, marksFor(node, marks)), task };
}

function list(node: HtmlNode, cx: Context, marks: Marks): string {
  const items: Item[] = [];
  for (const child of kids(node)) {
    if (isDropped(child, cx) || isBlankText(child)) continue;
    const tag = tagOf(child);
    if (tag === 'li') {
      items.push(itemOf(child, cx, marks));
    } else if (tag === 'ul' || tag === 'ol') {
      // Google Docs puts a nested list next to the item it belongs to, not inside it.
      const text = list(child, cx, marks);
      if (!text) continue;
      if (!items.length) items.push({ blocks: [], task: null });
      items[items.length - 1].blocks.push({ kind: 'list', text });
    } else {
      const wrapper: HtmlNode = { nodeType: 1, nodeName: 'DIV', nodeValue: null, childNodes: [child] };
      const blocks = blocksOf(wrapper, cx, marks);
      if (blocks.length) items.push({ blocks, task: null });
    }
  }
  const start = Number.parseInt(attr(node, 'start'), 10);
  return renderList(items, tagOf(node) === 'ol', Number.isFinite(start) && start >= 0 ? start : 1, cx);
}

function renderList(items: Item[], ordered: boolean, start: number, cx: Context): string {
  const kept = items.filter((it) => it.blocks.length || it.task !== null);
  if (!kept.length) return '';
  cx.rich = true;
  // One item with two paragraphs makes the whole list a loose one.
  const loose = kept.some((it) => it.blocks.filter((b) => b.kind !== 'list').length > 1);
  return kept
    .map((it, i) => {
      const marker = ordered ? `${start + i}. ` : '- ';
      const box = it.task === null ? '' : it.task ? '[x] ' : '[ ] ';
      const body = box + it.blocks.map((b) => b.text).join(loose ? '\n\n' : '\n');
      return prefixLines(body, marker, ' '.repeat(marker.length));
    })
    .join(loose ? '\n\n' : '\n');
}

/** Word writes a list as paragraphs styled `mso-list:l0 level2 lfo1`. Returns the level, or 0. */
function wordListLevel(node: HtmlNode): number {
  if (node.nodeType !== 1) return 0;
  const m = /\blevel(\d+)\b/.exec(styleOf(node).get('mso-list') ?? '');
  return m ? Math.max(1, Number(m[1])) : 0;
}

function wordMarker(node: HtmlNode): string | null {
  if (node.nodeType !== 1) return null;
  if (isWordListMarker(node)) return textOf(node);
  for (const child of kids(node)) {
    const found = wordMarker(child);
    if (found !== null) return found;
  }
  return null;
}

interface WordEntry {
  level: number;
  ordered: boolean;
  blocks: Block[];
}

function wordList(children: HtmlNode[], i: number, out: Block[], cx: Context, marks: Marks): number {
  const entries: WordEntry[] = [];
  let last = i;
  for (let j = i; j < children.length; j++) {
    const node = children[j];
    if (isBlankText(node) || node.nodeType === 8) continue;
    const level = wordListLevel(node);
    if (!level) break;
    const marker = cleanText(wordMarker(node) ?? '').trim();
    entries.push({ level, ordered: /^(?:\d+|[a-z]{1,4})[.)]/i.test(marker), blocks: blocksOf(node, cx, marksFor(node, marks)) });
    last = j;
  }
  let at = 0;
  const nest = (level: number): string => {
    const ordered = entries[at].ordered;
    const items: Item[] = [];
    while (at < entries.length && entries[at].level >= level) {
      if (entries[at].level > level) {
        const text = nest(entries[at].level);
        if (!items.length) items.push({ blocks: [], task: null });
        if (text) items[items.length - 1].blocks.push({ kind: 'list', text });
      } else {
        items.push({ blocks: entries[at].blocks, task: null });
        at++;
      }
    }
    return renderList(items, ordered, 1, cx);
  };
  while (at < entries.length) {
    const text = nest(entries[at].level);
    if (text) out.push({ kind: 'list', text });
  }
  return last;
}

/* ---------- tables ---------- */

function cellAlign(cell: HtmlNode): Align {
  const value = (attr(cell, 'align') || styleOf(cell).get('text-align') || '').toLowerCase();
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

function hasTable(node: HtmlNode): boolean {
  return kids(node).some((k) => tagOf(k) === 'table' || hasTable(k));
}

function table(node: HtmlNode, out: Block[], cx: Context, marks: Marks): void {
  const rowNodes: HtmlNode[] = [];
  for (const child of kids(node)) {
    const tag = tagOf(child);
    if (tag === 'tr') rowNodes.push(child);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') rowNodes.push(...kids(child).filter((k) => tagOf(k) === 'tr'));
  }
  const cellNodes = rowNodes.map((row) => kids(row).filter((k) => tagOf(k) === 'th' || tagOf(k) === 'td')).filter((row) => row.length);
  const all = cellNodes.flat();
  if (!all.length) return;
  // A single cell, or cells that hold tables, is layout and not data.
  if (all.length === 1 || all.some(hasTable)) {
    for (const cell of all) out.push(...blocksOf(cell, cx, marks));
    return;
  }
  const outer = cx.cell;
  cx.cell = true;
  const rows = cellNodes.map((row, r) => {
    const cells: string[] = [];
    for (const cell of row) {
      const header = r === 0 || tagOf(cell) === 'th';
      const inner = marksFor(cell, marks);
      const text = blocksOf(cell, cx, header ? { ...inner, bold: false } : inner)
        .map((b) => b.text.replace(/\\?\n/g, '<br>'))
        .join('<br>');
      // A header cell is bold already.
      cells.push(header ? text.replace(/^\*\*([^*]+)\*\*$/, '$1') : text);
      const span = Math.min(50, Number.parseInt(attr(cell, 'colspan'), 10) || 1);
      for (let s = 1; s < span; s++) cells.push('');
    }
    return cells;
  });
  cx.cell = outer;
  if (rows.every((row) => row.every((c) => c === ''))) return;
  const cols = Math.max(...rows.map((r) => r.length));
  for (const row of rows) while (row.length < cols) row.push('');
  const align: Align[] = new Array<Align>(cols).fill(null);
  let col = 0;
  for (const cell of cellNodes[0]) {
    align[col] = cellAlign(cell);
    col += Math.min(50, Number.parseInt(attr(cell, 'colspan'), 10) || 1);
  }
  cx.rich = true;
  out.push({ kind: 'other', text: serializeTable({ rows, align: align.slice(0, cols) }, true) });
}

/* ---------- entry points ---------- */

/** Converts a parsed tree. `root` is a document, a `<body>` or any container element. */
export function convertNode(root: HtmlNode): Conversion {
  const cx: Context = { rich: false, skip: new Set(), cell: false };
  const blocks = blocksOf(root, cx);
  return { markdown: join(blocks), rich: cx.rich, block: blocks.length !== 1 || blocks[0].kind !== 'p' };
}

/** Parses HTML into a document that is never rendered: its scripts do not run and its images do not load. */
export function parseHtml(html: string): HtmlNode {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function htmlToMarkdown(html: string): string {
  return convertNode(parseHtml(html)).markdown;
}

/**
 * True when the HTML is a dump of source code, as editors put on the clipboard for syntax colours:
 * a single `<pre>`, or a single wrapper whose font is a fixed-width one.
 */
export function isCodeDump(root: HtmlNode): boolean {
  const cx: Context = { rich: false, skip: new Set(), cell: false };
  let node = root;
  for (let depth = 0; depth < 12; depth++) {
    const content = kids(node).filter((k) => !isDropped(k, cx) && !isBlankText(k));
    if (content.length !== 1 || content[0].nodeType !== 1) return false;
    const only = content[0];
    const tag = tagOf(only);
    if (tag === 'pre') return true;
    if (tag !== 'html' && tag !== 'body' && tag !== 'div' && tag !== 'span') return false;
    if (MONOSPACE.test(styleOf(only).get('font-family') ?? '')) return true;
    node = only;
  }
  return false;
}

/**
 * True when the clipboard holds text in both forms. Word and Excel add a picture of what was
 * copied; with this, the text is pasted and not that picture.
 */
export function hasFormattedText(plain: string, html: string): boolean {
  return plain.trim() !== '' && html.trim() !== '';
}

/** Larger clipboards are pasted as plain text rather than holding up the editor. */
const MAX_HTML = 4_000_000;

/**
 * Decides what a paste of this clipboard HTML inserts. Returns null when the plain text should be
 * pasted as usual: the copy came from a code editor, or the HTML carries no formatting at all.
 */
export function markdownForPaste(html: string, types: readonly string[] = []): Conversion | null {
  if (!html.trim() || html.length > MAX_HTML || types.includes('vscode-editor-data')) return null;
  const root = parseHtml(html);
  if (isCodeDump(root)) return null;
  const result = convertNode(root);
  return result.rich && result.markdown.trim() !== '' ? result : null;
}
