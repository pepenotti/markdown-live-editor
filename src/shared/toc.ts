// Table of contents: a nested list of links to the headings of a document, kept
// between two marker comments so it can be found and regenerated.
//
//   <!-- toc -->
//   - [Getting started](#getting-started)
//     - [Install](#install)
//   <!-- tocstop -->
//
// Pure code, shared by the extension host (update command, update on save) and the
// webview (insert command, slash menu).
import { eachContentLine, extractHeadings, headingPlainText, headingSlugs } from './textUtil';

export const TOC_START = '<!-- toc -->';
export const TOC_END = '<!-- tocstop -->';
const START_RE = /^ {0,3}<!--\s*toc\s*-->\s*$/i;
const END_RE = /^ {0,3}<!--\s*tocstop\s*-->\s*$/i;

/** True for a line that is one of the two marker comments. */
export function isTocMarker(line: string): boolean {
  return START_RE.test(line) || END_RE.test(line);
}

export interface TocOptions {
  /** Shallowest and deepest heading level listed, 1 to 6. */
  minLevel: number;
  maxLevel: number;
  /** Numbered list instead of bullets. */
  ordered: boolean;
}

export const DEFAULT_TOC_OPTIONS: TocOptions = { minLevel: 1, maxLevel: 6, ordered: false };

/** Reads a level range such as "2..4", "2-4" or "3". Anything else means every level. */
export function parseTocLevels(value: unknown): { minLevel: number; maxLevel: number } {
  const m = /^\s*([1-6])\s*(?:(?:\.{2,3}|-|–)\s*([1-6])\s*)?$/.exec(typeof value === 'string' ? value : '');
  if (!m) return { minLevel: 1, maxLevel: 6 };
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return { minLevel: Math.min(a, b), maxLevel: Math.max(a, b) };
}

export interface TocMarkers {
  /** Zero-based line of `<!-- toc -->`. */
  startLine: number;
  /** Zero-based line of `<!-- tocstop -->`. */
  endLine: number;
}

/**
 * The first pair of marker lines, or null when the document has no complete pair.
 * Markers inside fenced code blocks and front matter do not count.
 */
export function findTocMarkers(text: string): TocMarkers | null {
  let startLine = -1;
  let endLine = -1;
  eachContentLine(text, (line, i) => {
    if (endLine >= 0) return;
    if (startLine < 0) {
      if (START_RE.test(line)) startLine = i;
    } else if (END_RE.test(line)) endLine = i;
  });
  return endLine >= 0 ? { startLine, endLine } : null;
}

/**
 * The lines of the list for this document. Headings between the markers are not listed.
 * A lone H1 is taken to be the title of the document and is left out.
 */
export function tocLines(text: string, options: TocOptions = DEFAULT_TOC_OPTIONS, markers: TocMarkers | null = findTocMarkers(text)): string[] {
  const headings = extractHeadings(text).filter((h) => !markers || h.line < markers.startLine || h.line > markers.endLine);
  const slugs = headingSlugs(headings);
  const h1 = headings.filter((h) => h.level === 1);
  const title = h1.length === 1 ? h1[0] : null;

  const out: string[] = [];
  /** Open ancestors of the current entry: their level and how far their text is indented. */
  const stack: { level: number; indent: number }[] = [];
  /** Number of the last item written at each depth. */
  const counters: number[] = [];
  headings.forEach((h, i) => {
    if (h === title || h.level < options.minLevel || h.level > options.maxLevel) return;
    const label = headingPlainText(h.text).replace(/[[\]]/g, '\\$&');
    if (!label) return;
    while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
    const depth = stack.length;
    counters.length = depth + 1;
    counters[depth] = (counters[depth] ?? 0) + 1;
    const indent = depth ? stack[depth - 1].indent : 0;
    const marker = options.ordered ? `${counters[depth]}. ` : '- ';
    out.push(' '.repeat(indent) + marker + (slugs[i] ? `[${label}](#${slugs[i]})` : label));
    // A nested list has to start under the text of its parent item.
    stack.push({ level: h.level, indent: indent + marker.length });
  });
  return out;
}

/** The whole block including its markers, with LF line breaks and no trailing break. */
export function tocBlock(text: string, options: TocOptions = DEFAULT_TOC_OPTIONS): string {
  return [TOC_START, ...tocLines(text, options, null), TOC_END].join('\n');
}

export interface TocEdit {
  /** Offsets in the text that was passed in, whatever its line endings. */
  from: number;
  to: number;
  insert: string;
}

/**
 * The single replacement that brings the list between the markers up to date, using
 * the line ending of the document. Null when there are no markers or nothing to change.
 * Only text strictly between the two marker lines is ever replaced.
 */
export function tocUpdate(text: string, options: TocOptions = DEFAULT_TOC_OPTIONS): TocEdit | null {
  const markers = findTocMarkers(text);
  if (!markers) return null;
  // Start offset of every line, and the line break that ends each one.
  const starts = [0];
  const breaks: string[] = [];
  const re = /\r\n|\r|\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    starts.push(m.index + m[0].length);
    breaks.push(m[0]);
  }
  const eol = breaks[markers.startLine];
  const from = starts[markers.startLine + 1];
  const to = starts[markers.endLine];
  const insert = tocLines(text, options, markers)
    .map((line) => line + eol)
    .join('');
  return text.slice(from, to) === insert ? null : { from, to, insert };
}
