// The outline panel's model: the headings of a document read from its syntax tree, the
// filter, and which heading the reader is in. No DOM here; see ui/outlinePanel.ts.
import type { ChangeDesc, Text } from '@codemirror/state';
import { IterMode, type SyntaxNode, type Tree } from '@lezer/common';
import { texOf } from '../shared/markdownSyntax';

export interface OutlineItem {
  /** 1 to 6. */
  level: number;
  /** The heading as a reader sees it: no `#`, emphasis marks, link targets or HTML tags. */
  text: string;
  /** Start of the heading in the document. */
  from: number;
  /** Index of the closest earlier heading of a lower level, or -1. */
  parent: number;
  /** How many parents the heading has: what the panel indents by. */
  depth: number;
}

/** Blocks whose content is never a heading. */
const OPAQUE = new Set(['FencedCode', 'CodeBlock', 'FrontMatter', 'HTMLBlock', 'CommentBlock', 'BlockMath']);

/** Inline syntax that is markup, not text a reader sees. */
const MARKUP = new Set([
  'HeaderMark',
  'QuoteMark',
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'LinkTitle',
  'LinkLabel',
  'StrikethroughMark',
  'FootnoteReference',
  'HTMLTag',
  'Comment',
  'ProcessingInstruction',
  'WikiLinkMark',
]);

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntity(source: string): string {
  const name = source.slice(1, -1);
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : source;
  }
  return ENTITIES[name] ?? source;
}

function headingLevel(name: string): number {
  if (name.startsWith('ATXHeading')) return Number(name.slice(10)) || 0;
  if (name === 'SetextHeading1') return 1;
  if (name === 'SetextHeading2') return 2;
  return 0;
}

/** The text of a node with its markup left out. */
function plainText(node: SyntaxNode, slice: (from: number, to: number) => string): string {
  switch (node.name) {
    case 'Escape':
      return slice(node.from + 1, node.to);
    case 'Entity':
      return decodeEntity(slice(node.from, node.to));
    case 'InlineMath':
      return texOf(slice(node.from, node.to));
    case 'WikiLink': {
      // [[Note#Heading|shown]] reads as "shown", [[Note]] as "Note".
      const inner = slice(node.from + 2, node.to - 2);
      const bar = inner.indexOf('|');
      return bar >= 0 ? inner.slice(bar + 1) : inner;
    }
  }
  if (MARKUP.has(node.name)) return '';
  // The target of a link or image is markup; a bare or <angle-bracketed> URL is the text itself.
  if (node.name === 'URL' && (node.parent?.name === 'Link' || node.parent?.name === 'Image')) return '';
  let out = '';
  let pos = node.from;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    out += slice(pos, child.from) + plainText(child, slice);
    pos = child.to;
  }
  return out + slice(pos, node.to);
}

/**
 * The ATX and setext headings of a document, in order. Headings inside code blocks, front
 * matter, HTML blocks and math are not headings and are not in the tree as such.
 */
export function outlineFromTree(tree: Tree, slice: (from: number, to: number) => string): OutlineItem[] {
  const items: OutlineItem[] = [];
  /** The open headings, from the outermost: candidates for the parent of the next one. */
  const stack: number[] = [];
  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(ref) {
      if (OPAQUE.has(ref.name)) return false;
      const level = headingLevel(ref.name);
      if (!level) return undefined;
      const text = plainText(ref.node, slice).replace(/\s+/g, ' ').trim();
      while (stack.length && items[stack[stack.length - 1]].level >= level) stack.pop();
      const parent = stack.length ? stack[stack.length - 1] : -1;
      items.push({ level, text, from: ref.from, parent, depth: stack.length });
      stack.push(items.length - 1);
      return false;
    },
  });
  return items;
}

/** Whether two outlines show the same list, so the panel need not be redrawn. Positions are not compared. */
export function sameOutline(a: readonly OutlineItem[], b: readonly OutlineItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].level !== b[i].level || a[i].text !== b[i].text) return false;
  return true;
}

/**
 * Which items to show for a filter: the headings whose text contains the query (ignoring
 * case), and their parents so that a match keeps its context. Null shows everything.
 */
export function filterOutline(items: readonly OutlineItem[], query: string): { visible: Set<number>; matches: Set<number> } | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const visible = new Set<number>();
  const matches = new Set<number>();
  items.forEach((item, i) => {
    if (!item.text.toLowerCase().includes(q)) return;
    matches.add(i);
    for (let at = i; at >= 0 && !visible.has(at); at = items[at].parent) visible.add(at);
  });
  return { visible, matches };
}

/** The last heading that starts at or before `pos`, or -1 when `pos` is above the first heading. */
export function headingAt(items: readonly OutlineItem[], pos: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].from <= pos) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The heading the panel highlights: the one the cursor is under, or, while the reader
 * scrolls without moving the cursor, the one at the top of the visible text.
 */
export function currentHeading(items: readonly OutlineItem[], at: { cursor: number; top: number; follow: 'cursor' | 'scroll' }): number {
  return headingAt(items, at.follow === 'scroll' ? at.top : at.cursor);
}

/** A line that is a heading, or opens or closes a block that a heading cannot be in. */
const STRUCTURAL = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?#|^[ \t>]*(?:```|~~~|\$\$|<)|^---/;
/** A setext underline, which makes the paragraph above it a heading. */
const UNDERLINE = /^[ \t>]*(?:=+|-+)[ \t]*$/;
/** How far below an edit to look for the underline of the paragraph it is in. */
const PARAGRAPH_LOOKAHEAD = 40;

/**
 * Whether an edit could change the list of headings. A cheap look at the lines it touched,
 * before and after, and at the rest of the paragraph below it (for a setext underline), so
 * that typing in an ordinary paragraph never rebuilds the outline.
 */
export function outlineMayChange(before: Text, after: Text, changes: ChangeDesc): boolean {
  let may = false;
  changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (may) return;
    const lines = (doc: Text, from: number, to: number) => {
      for (let n = doc.lineAt(from).number, last = doc.lineAt(to).number; n <= last; n++) if (STRUCTURAL.test(doc.line(n).text) || UNDERLINE.test(doc.line(n).text)) return true;
      return false;
    };
    if (lines(before, fromA, toA) || lines(after, fromB, toB)) {
      may = true;
      return;
    }
    for (let n = after.lineAt(toB).number + 1, last = Math.min(after.lines, n + PARAGRAPH_LOOKAHEAD); n <= last; n++) {
      const text = after.line(n).text;
      if (UNDERLINE.test(text)) may = true;
      if (may || text.trim() === '') return;
    }
  });
  return may;
}
