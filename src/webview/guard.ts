// A transaction filter that keeps typing from breaking syntax the user cannot see.
//
// 1. Rendered blocks (tables, and in full preview code fences and front matter) occupy
//    whole source lines. Text typed at their edge would be glued onto those lines, so it
//    is moved onto a line of its own; other edits that would break them are dropped.
// 2. In full preview, replacing the text of a heading or list item keeps its marker.
// 3. In full preview, deleting all the text inside bold, code or a link removes the
//    now-empty markers as well.
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { blockField, type Protected } from './decorations/blocks';
import { afterLeadingAtoms, lineAtoms, linkInfo } from './decorations/inline';
import { bypassGuard, externalChange, modeField } from './modes';

interface Change {
  from: number;
  to: number;
  insert: string;
}

interface Violation {
  from: number;
  to: number;
  value: Protected;
  /** Set when the lines are intact but the table lost the blank line it needs on that side. */
  blank: 'before' | 'after' | null;
}

function findViolations(tr: Transaction, changes: readonly Change[]): Violation[] {
  const state = tr.startState;
  const doc = state.doc;
  const next = tr.newDoc;
  const out: Violation[] = [];
  const seen = new Set<number>();
  for (const ch of changes) {
    state.field(blockField).protected.between(Math.max(0, ch.from - 2), Math.min(doc.length, ch.to + 2), (pf, pt, value) => {
      if (seen.has(pf)) return;
      // Replacing or deleting the whole element is fine.
      if (ch.from <= pf - value.before && ch.to >= pt + value.after) return;
      const nf = tr.changes.mapPos(pf, 1);
      const nt = tr.changes.mapPos(pt, -1);
      const intact =
        nt - nf === pt - pf &&
        next.sliceString(nf, nt) === doc.sliceString(pf, pt) &&
        (nf === 0 || next.sliceString(nf - 1, nf) === '\n') &&
        (nt === next.length || next.sliceString(nt, nt + 1) === '\n');
      if (!intact) {
        seen.add(pf);
        out.push({ from: pf, to: pt, value, blank: null });
        return;
      }
      if (value.kind !== 'table') return;
      // A table runs until the first blank line: text on the next line would become a row.
      // Keep the blank line before it as well, which some renderers require.
      const blankLine = (doc2: typeof doc, pos: number) => pos < 0 || pos > doc2.length || doc2.lineAt(pos).text.trim() === '';
      if (blankLine(doc, pt + 1) && !blankLine(next, nt + 1)) {
        seen.add(pf);
        out.push({ from: pf, to: pt, value, blank: 'after' });
      } else if (blankLine(doc, pf - 1) && !blankLine(next, nf - 1)) {
        seen.add(pf);
        out.push({ from: pf, to: pt, value, blank: 'before' });
      }
    });
  }
  return out;
}

/** Moves text typed at the edge of a rendered block onto its own line. */
function redirect(ch: Change, v: Violation, userEvent: string | undefined): TransactionSpec | null {
  const text = ch.insert;
  const kind = v.value.kind;
  const make = (from: number, insert: string, cursor: number): TransactionSpec => ({
    changes: { from, insert },
    selection: EditorSelection.cursor(cursor),
    scrollIntoView: true,
    userEvent,
  });
  if (v.blank === 'after') {
    return ch.from === v.to + 1 ? make(ch.from, '\n' + text, ch.from + 1 + text.length) : null;
  }
  if (v.blank === 'before') {
    return ch.from === v.from - 1 ? make(ch.from, text + '\n', ch.from + text.length) : null;
  }
  if (ch.from === v.from) {
    if (kind === 'frontmatter') return null;
    if (kind === 'fence-close') return make(v.from, text + '\n', v.from + text.length);
    return make(v.from, text + (text.endsWith('\n') ? '\n' : '\n\n'), v.from + text.length);
  }
  if (ch.from === v.to) {
    if (kind === 'fence-open') return v.value.after > 0 ? make(v.to + 1, text, v.to + 1 + text.length) : null;
    if (kind === 'fence-close') return make(v.to, '\n' + text, v.to + 1 + text.length);
    return make(v.to, '\n\n' + text, v.to + 2 + text.length);
  }
  return null;
}

/** Text range between the markers of an inline element. */
function contentRange(state: EditorState, node: SyntaxNode): { from: number; to: number } | null {
  switch (node.name) {
    case 'Emphasis':
    case 'StrongEmphasis':
    case 'Strikethrough':
    case 'InlineCode': {
      const open = node.firstChild;
      const close = node.lastChild;
      return open && close && open !== close ? { from: open.to, to: close.from } : null;
    }
    case 'Link': {
      const info = linkInfo(state, node);
      return info && info.href !== null ? { from: info.textFrom, to: info.textTo } : null;
    }
    default:
      return null;
  }
}

function isTypedInput(tr: Transaction): boolean {
  return tr.isUserEvent('input.type') || tr.isUserEvent('input.paste') || tr.isUserEvent('input.drop') || tr.isUserEvent('input.complete');
}

export const editGuard = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.annotation(externalChange) || tr.annotation(bypassGuard)) return tr;
  const state = tr.startState;
  const mode = state.field(modeField);
  if (mode === 'raw') return tr;

  const changes: Change[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => changes.push({ from: fromA, to: toA, insert: inserted.toString() }));
  const userEvent = tr.annotation(Transaction.userEvent);

  if (state.field(blockField).protected.size) {
    const violations = findViolations(tr, changes);
    if (violations.length) {
      if (changes.length === 1 && violations.length === 1 && changes[0].from === changes[0].to) {
        const spec = redirect(changes[0], violations[0], userEvent);
        if (spec) return spec;
      }
      return [];
    }
  }

  if (mode !== 'full') return tr;

  if (isTypedInput(tr) && changes.length === 1) {
    const ch = changes[0];
    if (ch.to > ch.from && ch.insert !== '' && ch.to <= state.doc.lineAt(ch.from).to) {
      const end = afterLeadingAtoms(lineAtoms(state, ch.from), ch.from);
      if (end > ch.from && ch.to >= end) {
        return {
          changes: { from: end, to: ch.to, insert: ch.insert },
          selection: EditorSelection.cursor(end + ch.insert.length),
          scrollIntoView: true,
          userEvent,
        };
      }
    }
  }

  if (tr.isUserEvent('delete')) {
    const tree = syntaxTree(state);
    let widened = false;
    const wider = changes.map((ch) => {
      if (ch.insert !== '' || ch.to === ch.from) return ch;
      let lo = ch.from;
      let hi = ch.to;
      // Widening to one element can empty the element around it (as in ***both***), so repeat.
      for (let grew = true; grew; ) {
        grew = false;
        tree.iterate({
          from: lo,
          to: hi,
          enter(ref) {
            if (ref.from >= lo && ref.to <= hi) return false;
            const c = contentRange(state, ref.node);
            if (c && c.to > c.from && c.from >= lo && c.to <= hi) {
              lo = Math.min(lo, ref.from);
              hi = Math.max(hi, ref.to);
              grew = true;
            }
            return true;
          },
        });
      }
      if (lo === ch.from && hi === ch.to) return ch;
      widened = true;
      return { from: lo, to: hi, insert: '' };
    });
    if (widened) {
      const merged: Change[] = [];
      for (const ch of wider.sort((a, b) => a.from - b.from)) {
        const last = merged[merged.length - 1];
        if (last && ch.from <= last.to) last.to = Math.max(last.to, ch.to);
        else merged.push({ ...ch });
      }
      const set = state.changes(merged);
      return { changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent };
    }
  }

  return tr;
});
