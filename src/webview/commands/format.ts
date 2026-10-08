// Formatting commands. Each one is a pure function from an editor state to a
// transaction, so it can be tested without a DOM.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, type ChangeSpec, type EditorState, type Line, type SelectionRange, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { emptyTable } from '../table/model';

export type FormatCommand = (state: EditorState) => TransactionSpec | null;

const USER_EVENT = 'input.format';

interface InlineKind {
  marker: string;
  node: string;
}

const INLINE: Record<'bold' | 'italic' | 'strike' | 'code', InlineKind> = {
  bold: { marker: '**', node: 'StrongEmphasis' },
  italic: { marker: '*', node: 'Emphasis' },
  strike: { marker: '~~', node: 'Strikethrough' },
  code: { marker: '`', node: 'InlineCode' },
};

function enclosing(state: EditorState, from: number, to: number, name: string): SyntaxNode | null {
  const tree = syntaxTree(state);
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = tree.resolveInner(from, side); n; n = n.parent) {
      if (n.name === name && n.from <= from && n.to >= to && n.firstChild && n.lastChild && n.firstChild !== n.lastChild) return n;
    }
  }
  return null;
}

/** Wraps the selection in an inline marker, or removes the marker when it is already there. */
export function toggleInline(kind: keyof typeof INLINE): FormatCommand {
  const { marker, node: nodeName } = INLINE[kind];
  return (state) => {
    const result = state.changeByRange((range) => {
      const node = enclosing(state, range.from, range.to, nodeName);
      if (node) {
        const open = node.firstChild!;
        const close = node.lastChild!;
        // A cursor at the end of the formatted text steps out instead of removing the format.
        if (range.empty && range.from === close.from && close.from > open.to) {
          return { range: EditorSelection.cursor(close.to) };
        }
        const openLen = open.to - open.from;
        const closeLen = close.to - close.from;
        const map = (p: number) => {
          if (p >= close.to) return p - openLen - closeLen;
          if (p >= close.from) return close.from - openLen;
          if (p >= open.to) return p - openLen;
          return Math.min(p, open.from);
        };
        return {
          changes: [
            { from: open.from, to: open.to },
            { from: close.from, to: close.to },
          ],
          range: EditorSelection.range(map(range.anchor), map(range.head)),
        };
      }

      if (range.empty) {
        const word = state.wordAt(range.head);
        if (word && !word.empty) {
          return {
            changes: [
              { from: word.from, insert: marker },
              { from: word.to, insert: marker },
            ],
            range: EditorSelection.cursor(range.head + marker.length),
          };
        }
        return {
          changes: { from: range.head, insert: marker + marker },
          range: EditorSelection.cursor(range.head + marker.length),
        };
      }

      // Wrap each line of the selection separately and keep markers tight against the text.
      const changes: ChangeSpec[] = [];
      let first = -1;
      let last = -1;
      let added = 0;
      for (let pos = range.from; pos <= range.to; ) {
        const line = state.doc.lineAt(pos);
        let from = Math.max(line.from, range.from);
        let to = Math.min(line.to, range.to);
        const text = state.doc.sliceString(from, to);
        const lead = text.length - text.trimStart().length;
        const trail = text.length - text.trimEnd().length;
        if (text.trim() !== '') {
          from += lead;
          to -= trail;
          changes.push({ from, insert: marker }, { from: to, insert: marker });
          if (first < 0) first = from;
          last = to;
          added += 2;
        }
        pos = line.to + 1;
      }
      if (first < 0) return { range };
      return {
        changes,
        range: EditorSelection.range(first + marker.length, last + marker.length * (added - 1)),
      };
    });
    return { ...result, scrollIntoView: true, userEvent: USER_EVENT };
  };
}

/* ---------- line based commands ---------- */

interface LineEdit {
  from: number;
  to: number;
  insert: string;
}

function selectedLines(state: EditorState): Line[] {
  const lines: Line[] = [];
  let lastNumber = 0;
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number;
    let last = state.doc.lineAt(range.to).number;
    // A selection that ends at the very start of a line does not include that line.
    if (last > first && state.doc.line(last).from === range.to) last--;
    for (let n = Math.max(first, lastNumber + 1); n <= last; n++) lines.push(state.doc.line(n));
    lastNumber = Math.max(lastNumber, last);
  }
  return lines;
}

/** Applies prefix edits and keeps cursors that sat inside a prefix behind the new one. */
function applyLineEdits(state: EditorState, edits: LineEdit[]): TransactionSpec | null {
  if (!edits.length) return null;
  const changes = state.changes(edits);
  const map = (p: number) => {
    for (const e of edits) if (p >= e.from && p <= e.to) return changes.mapPos(e.to, 1);
    return changes.mapPos(p, 1);
  };
  const selection = EditorSelection.create(
    state.selection.ranges.map((r) => EditorSelection.range(map(r.anchor), map(r.head))),
    state.selection.mainIndex,
  );
  return { changes, selection, scrollIntoView: true, userEvent: USER_EVENT };
}

const HEADING = /^( {0,3})(#{1,6})(?:[ \t]+|$)/;

function headingLevel(text: string): number {
  const m = HEADING.exec(text);
  return m ? m[2].length : 0;
}

function headingEdit(line: Line, level: number): LineEdit | null {
  const m = HEADING.exec(line.text);
  const indent = m ? m[1].length : 0;
  const prefixEnd = m ? m[0].length : 0;
  const insert = level > 0 ? '#'.repeat(level) + ' ' : '';
  if (line.text.slice(indent, prefixEnd) === insert) return null;
  return { from: line.from + indent, to: line.from + prefixEnd, insert };
}

/** Sets the heading level of the selected lines; the same level again turns them back into text. */
export function setHeading(level: number): FormatCommand {
  return (state) => {
    const all = selectedLines(state);
    const lines = all.length > 1 ? all.filter((l) => l.text.trim() !== '') : all;
    const target = lines.every((l) => headingLevel(l.text) === level) ? 0 : level;
    return applyLineEdits(state, lines.map((l) => headingEdit(l, target)).filter((e): e is LineEdit => !!e));
  };
}

/** Moves the selected lines one heading level deeper (+1) or shallower (-1). */
export function shiftHeading(by: 1 | -1): FormatCommand {
  return (state) => {
    const edits: LineEdit[] = [];
    for (const line of selectedLines(state)) {
      const level = headingLevel(line.text);
      const next = Math.max(0, Math.min(6, level + by));
      const e = next === level ? null : headingEdit(line, next);
      if (e) edits.push(e);
    }
    return applyLineEdits(state, edits);
  };
}

const LIST = /^(\s*)(?:([-*+])|(\d{1,9})([.)]))(?:[ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?/;

type ListKind = 'bullet' | 'ordered' | 'task';

interface ListPrefix {
  indent: string;
  kind: ListKind;
  checked: boolean;
  length: number;
}

function listPrefix(text: string): ListPrefix | null {
  const m = LIST.exec(text);
  if (!m) return null;
  const kind: ListKind = m[5] ? 'task' : m[2] ? 'bullet' : 'ordered';
  return { indent: m[1], kind, checked: !!m[5] && /[xX]/.test(m[5]), length: m[0].length };
}

/** Turns the selected lines into a list of the given kind, or back into plain lines. */
export function toggleList(kind: ListKind): FormatCommand {
  return (state) => {
    const all = selectedLines(state);
    const lines = all.length > 1 ? all.filter((l) => l.text.trim() !== '') : all;
    const allSame = lines.length > 0 && lines.every((l) => listPrefix(l.text)?.kind === kind);
    const edits: LineEdit[] = [];
    let n = 1;
    for (const line of lines) {
      const p = listPrefix(line.text);
      const indent = p ? p.indent : /^\s*/.exec(line.text)![0];
      const from = line.from + indent.length;
      const to = line.from + (p ? p.length : indent.length);
      let insert = '';
      if (!allSame) {
        if (kind === 'bullet') insert = '- ';
        else if (kind === 'ordered') insert = `${n++}. `;
        else insert = `- [${p?.checked ? 'x' : ' '}] `;
      }
      if (state.doc.sliceString(from, to) !== insert) edits.push({ from, to, insert });
    }
    return applyLineEdits(state, edits);
  };
}

/** Ticks or unticks task items; other lines become unchecked tasks. */
export const toggleTask: FormatCommand = (state) => {
  const all = selectedLines(state);
  const lines = all.length > 1 ? all.filter((l) => l.text.trim() !== '') : all;
  const edits: LineEdit[] = [];
  for (const line of lines) {
    const p = listPrefix(line.text);
    if (p?.kind === 'task') {
      const box = line.text.indexOf('[', p.indent.length);
      edits.push({ from: line.from + box + 1, to: line.from + box + 2, insert: p.checked ? ' ' : 'x' });
    } else {
      const indent = p ? p.indent : /^\s*/.exec(line.text)![0];
      edits.push({ from: line.from + indent.length, to: line.from + (p ? p.length : indent.length), insert: '- [ ] ' });
    }
  }
  return applyLineEdits(state, edits);
};

const QUOTE = /^( {0,3})>[ \t]?/;

export const toggleQuote: FormatCommand = (state) => {
  const lines = selectedLines(state);
  const nonBlank = lines.filter((l) => l.text.trim() !== '');
  const remove = nonBlank.length > 0 && nonBlank.every((l) => QUOTE.test(l.text));
  const edits: LineEdit[] = [];
  for (const line of lines) {
    const m = QUOTE.exec(line.text);
    if (remove) {
      if (m) edits.push({ from: line.from + m[1].length, to: line.from + m[0].length, insert: '' });
    } else {
      edits.push({ from: line.from, to: line.from, insert: '> ' });
    }
  }
  return applyLineEdits(state, edits);
};

/* ---------- block inserts ---------- */

function isBlank(state: EditorState, lineNumber: number): boolean {
  return lineNumber < 1 || lineNumber > state.doc.lines || state.doc.line(lineNumber).text.trim() === '';
}

/**
 * Inserts `text` as its own block at the cursor with a blank line on both sides.
 * `select` is a range inside `text` to select afterwards.
 */
export function insertBlock(state: EditorState, text: string, select?: { from: number; to: number }): TransactionSpec {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.to);
  let from: number;
  let to: number;
  let before = '';
  let after = '';
  if (line.text.trim() === '') {
    from = line.from;
    to = line.to;
    if (!isBlank(state, line.number - 1)) before = '\n';
  } else {
    from = to = line.to;
    before = '\n\n';
  }
  if (!isBlank(state, line.number + 1)) after = '\n';
  const start = from + before.length;
  const sel = select ?? { from: text.length, to: text.length };
  return {
    changes: { from, to, insert: before + text + after },
    selection: EditorSelection.range(start + sel.from, start + sel.to),
    scrollIntoView: true,
    userEvent: USER_EVENT,
  };
}

/**
 * Replaces the selection with pasted Markdown, as one change. With `block` the text is put on
 * lines of its own, with a blank line between it and whatever is around it.
 */
export function pasteMarkdown(state: EditorState, text: string, block: boolean): TransactionSpec {
  const range = state.selection.main;
  let from = range.from;
  let to = range.to;
  let before = '';
  let after = '';
  if (block) {
    const first = state.doc.lineAt(from);
    if (state.doc.sliceString(first.from, from).trim() === '') {
      from = first.from;
      if (!isBlank(state, first.number - 1)) before = '\n';
    } else {
      // The line is split here, so the spaces around the split would only be left dangling.
      from -= /[ \t]*$/.exec(state.doc.sliceString(first.from, from))![0].length;
      before = '\n\n';
    }
    const last = state.doc.lineAt(to);
    if (state.doc.sliceString(to, last.to).trim() === '') {
      to = last.to;
      if (!isBlank(state, last.number + 1)) after = '\n';
    } else {
      to += /^[ \t]*/.exec(state.doc.sliceString(to, last.to))![0].length;
      after = '\n\n';
    }
  }
  return {
    changes: { from, to, insert: before + text + after },
    selection: EditorSelection.cursor(from + before.length + text.length),
    scrollIntoView: true,
    userEvent: 'input.paste',
  };
}

export const insertCodeBlock: FormatCommand = (state) => {
  const range = state.selection.main;
  if (range.empty) return insertBlock(state, '```\n\n```', { from: 4, to: 4 });
  const first = state.doc.lineAt(range.from);
  const last = state.doc.lineAt(range.to);
  const body = state.doc.sliceString(first.from, last.to);
  const fence = /^```/m.test(body) ? '````' : '```';
  const before = isBlank(state, first.number - 1) ? '' : '\n';
  const after = isBlank(state, last.number + 1) ? '' : '\n';
  const open = before + fence + '\n';
  return {
    changes: { from: first.from, to: last.to, insert: open + body + '\n' + fence + after },
    selection: EditorSelection.range(first.from + open.length, first.from + open.length + body.length),
    scrollIntoView: true,
    userEvent: USER_EVENT,
  };
};

export const insertRule: FormatCommand = (state) => {
  const spec = insertBlock(state, '---\n');
  return spec;
};

export function insertTable(rows = 3, cols = 3): FormatCommand {
  return (state) => insertBlock(state, emptyTable(rows, cols), { from: 2, to: 10 });
}

const URL_RE = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

function findLink(state: EditorState, range: SelectionRange): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(range.from, -1); n; n = n.parent) {
    if (n.name === 'Link' && n.from <= range.from && n.to >= range.to) return n;
  }
  return null;
}

/** Makes the selection a link. Inside an existing link it selects the URL instead. */
export const insertLink: FormatCommand = (state) => {
  const range = state.selection.main;
  const existing = findLink(state, range);
  if (existing) {
    const url = existing.getChild('URL');
    if (url) return { selection: EditorSelection.range(url.from, url.to), scrollIntoView: true };
    const open = existing.getChildren('LinkMark').find((m) => state.doc.sliceString(m.from, m.to) === '(');
    return open ? { selection: EditorSelection.cursor(open.to), scrollIntoView: true } : null;
  }
  let from = range.from;
  let to = range.to;
  if (range.empty) {
    const word = state.wordAt(range.head);
    if (word) {
      from = word.from;
      to = word.to;
    }
  }
  const text = state.doc.sliceString(from, to);
  if (text.includes('\n')) return null;
  if (text === '') {
    const placeholder = 'link text';
    return {
      changes: { from, insert: `[${placeholder}]()` },
      selection: EditorSelection.range(from + 1, from + 1 + placeholder.length),
      scrollIntoView: true,
      userEvent: USER_EVENT,
    };
  }
  if (URL_RE.test(text)) {
    return {
      changes: { from, to, insert: `[](${text})` },
      selection: EditorSelection.cursor(from + 1),
      scrollIntoView: true,
      userEvent: USER_EVENT,
    };
  }
  return {
    changes: { from, to, insert: `[${text}]()` },
    selection: EditorSelection.cursor(from + text.length + 3),
    scrollIntoView: true,
    userEvent: USER_EVENT,
  };
};

/** Encodes a path so it is safe inside the parentheses of a Markdown link. */
export function encodeLinkPath(path: string): string {
  return /[\s()<>]/.test(path) ? `<${path.replace(/[<>]/g, (c) => encodeURIComponent(c))}>` : path;
}

/** Inserts images or links for the given paths at a position (default: the cursor). */
export function insertPaths(items: readonly { path: string; isImage: boolean; name: string }[], at?: number): FormatCommand {
  return (state) => {
    if (!items.length) return null;
    const range = state.selection.main;
    const from = at ?? range.from;
    const to = at ?? range.to;
    const selected = at === undefined ? state.doc.sliceString(from, to).replace(/\n/g, ' ') : '';
    const text = items
      .map((it, i) => {
        const label = i === 0 && selected ? selected : it.isImage ? '' : it.name;
        return `${it.isImage ? '!' : ''}[${label}](${encodeLinkPath(it.path)})`;
      })
      .join(items.every((it) => it.isImage) && items.length > 1 ? '\n\n' : ' ');
    return {
      changes: { from, to, insert: text },
      selection: EditorSelection.cursor(from + text.length),
      scrollIntoView: true,
      userEvent: USER_EVENT,
    };
  };
}
