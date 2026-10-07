// Pure text helpers shared by the extension host, the webview and the tests.
import type { TextChange } from './protocol';

export function toLF(text: string): string {
  return text.indexOf('\r') === -1 ? text : text.replace(/\r\n?/g, '\n');
}

export interface Diff {
  from: number;
  /** End of the replaced range in the old text. */
  toA: number;
  /** End of the replacement in the new text. */
  toB: number;
}

/** Smallest single replacement that turns `a` into `b`, or null when they are equal. */
export function minimalDiff(a: string, b: string): Diff | null {
  if (a === b) return null;
  const max = Math.min(a.length, b.length);
  let from = 0;
  while (from < max && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  let endA = a.length;
  let endB = b.length;
  while (endA > from && endB > from && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  // Never split a surrogate pair.
  if (from > 0 && isHighSurrogate(a.charCodeAt(from - 1))) from--;
  if (endA < a.length && isLowSurrogate(a.charCodeAt(endA))) {
    endA++;
    endB++;
  }
  return { from, toA: endA, toB: endB };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Applies changes whose positions all refer to the original text.
 * Returns null when the changes are out of range, unsorted or overlapping.
 */
export function applyChanges(text: string, changes: readonly TextChange[]): string | null {
  let out = '';
  let pos = 0;
  for (const c of changes) {
    if (!(Number.isInteger(c.from) && Number.isInteger(c.to))) return null;
    if (c.from < pos || c.to < c.from || c.to > text.length) return null;
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

/** Zero-based line and character of an offset in LF text. */
export function positionAt(text: string, offset: number): { line: number; ch: number } {
  let line = 0;
  let lineStart = 0;
  for (;;) {
    const next = text.indexOf('\n', lineStart);
    if (next === -1 || next >= offset) break;
    line++;
    lineStart = next + 1;
  }
  return { line, ch: offset - lineStart };
}

/** Checks that the line/character pairs of a change agree with its offsets. */
export function changeIsConsistent(text: string, c: TextChange): boolean {
  const a = positionAt(text, c.from);
  const b = positionAt(text, c.to);
  return a.line === c.fromLine && a.ch === c.fromCh && b.line === c.toLine && b.ch === c.toCh;
}

export function countWords(text: string): number {
  const m = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return m ? m.length : 0;
}

/** GitHub-style heading slug. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Headings of a Markdown document, skipping fenced code blocks and front matter. */
export function extractHeadings(text: string): Heading[] {
  const lines = toLF(text).split('\n');
  const out: Heading[] = [];
  let fence: string | null = null;
  let i = 0;
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) {
        i = j + 1;
        break;
      }
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (h) out.push({ level: h[1].length, text: h[2], line: i });
  }
  return out;
}

export interface OutlineNode extends Heading {
  children: OutlineNode[];
}

/** Nests a flat list of headings by level. */
export function buildOutline(headings: readonly Heading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const h of headings) {
    const node: OutlineNode = { ...h, text: h.text.replace(/[*_`~]/g, '').trim() || '(empty heading)', children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
  }
  return roots;
}
