// Cursor behaviour around hidden syntax and rendered blocks.
import { deleteMarkupBackward, insertNewlineContinueMarkup } from '@codemirror/lang-markdown';
import { EditorSelection, type Extension, findClusterBreak, Prec } from '@codemirror/state';
import { type Command, EditorView, keymap } from '@codemirror/view';
import { blockField, protectedAt } from './decorations/blocks';
import { afterLeadingAtoms, lineAtoms } from './decorations/inline';
import { cursorFix, modeField } from './modes';
import { focusTableAt } from './widgets/table';

function singleCursor(view: EditorView): number | null {
  const sel = view.state.selection;
  return sel.ranges.length === 1 && sel.main.empty ? sel.main.head : null;
}

/** Moves one visible character, passing over hidden markers without a wasted key press. */
function moveVisible(dir: 1 | -1): Command {
  return (view) => {
    const state = view.state;
    const head = singleCursor(view);
    if (head === null || state.field(modeField) !== 'full') return false;
    const atoms = lineAtoms(state, head);
    let pos = head;
    for (;;) {
      const a = atoms.find((x) => x.kind !== 'line' && (dir > 0 ? x.from === pos : x.to === pos));
      if (!a) break;
      pos = dir > 0 ? a.to : a.from;
    }
    if (pos === head) return false;
    const line = state.doc.lineAt(pos);
    let next: number;
    if (dir > 0) next = pos >= line.to ? Math.min(state.doc.length, pos + 1) : line.from + findClusterBreak(line.text, pos - line.from, true);
    else next = pos <= line.from ? Math.max(0, pos - 1) : line.from + findClusterBreak(line.text, pos - line.from, false);
    view.dispatch({ selection: EditorSelection.cursor(next, dir > 0 ? -1 : 1), scrollIntoView: true, userEvent: 'select' });
    return true;
  };
}

/**
 * Backspace/Delete next to a hidden inline marker removes the neighbouring visible
 * character instead of the marker, which would leave half of a `**` pair behind.
 */
function deleteVisible(dir: 1 | -1): Command {
  return (view) => {
    const state = view.state;
    const head = singleCursor(view);
    if (head === null || state.field(modeField) !== 'full') return false;
    const atoms = lineAtoms(state, head);
    let pos = head;
    for (;;) {
      const a = atoms.find((x) => x.kind === 'inline' && (dir > 0 ? x.from === pos : x.to === pos));
      if (!a) break;
      pos = dir > 0 ? a.to : a.from;
    }
    if (pos === head) return false;
    const line = state.doc.lineAt(pos);
    const atEdge = dir > 0 ? pos >= line.to : pos <= line.from || atoms.some((x) => x.kind === 'leading' && x.to === pos);
    if (atEdge) {
      // Nothing visible left on this side: continue from there with the normal behaviour.
      view.dispatch({ selection: EditorSelection.cursor(pos), annotations: cursorFix.of(true) });
      return false;
    }
    const other = line.from + findClusterBreak(line.text, pos - line.from, dir > 0);
    view.dispatch({
      changes: { from: Math.min(pos, other), to: Math.max(pos, other) },
      scrollIntoView: true,
      userEvent: dir > 0 ? 'delete.forward' : 'delete.backward',
    });
    return true;
  };
}

/** Arrow up/down next to a rendered table moves into its cells. */
function enterTable(dir: 1 | -1): Command {
  return (view) => {
    const state = view.state;
    const head = singleCursor(view);
    if (head === null || state.field(modeField) === 'raw') return false;
    const here = protectedAt(state, head);
    if (here?.value.kind === 'table') {
      if (dir > 0 && head === here.from) return focusTableAt(view, here.from, 'first');
      if (dir < 0 && head === here.to) return focusTableAt(view, here.from, 'last');
      return false;
    }
    const line = state.doc.lineAt(head);
    // Only from the last (or first) visual row of a wrapped line.
    const moved = view.moveVertically(state.selection.main, dir > 0);
    if (moved.head !== head && state.doc.lineAt(moved.head).number === line.number) return false;
    const target = line.number + dir;
    if (target < 1 || target > state.doc.lines) return false;
    const neighbour = state.doc.line(target);
    const table = protectedAt(state, neighbour.from);
    if (table?.value.kind !== 'table') return false;
    return focusTableAt(view, table.from, dir > 0 ? 'first' : 'last');
  };
}

/**
 * Keeps the cursor out of places where typing would go wrong:
 * - on or inside a rendered table or collapsed front matter (the browser would put
 *   the typed text on a neighbouring line),
 * - in full preview, in front of a hidden line-start marker (typing there would turn
 *   "## Title" into "x## Title") and on hidden code fence lines.
 * The cursor continues in the direction it was moving.
 */
const keepCursorSensible = EditorView.updateListener.of((update) => {
  const state = update.state;
  const mode = state.field(modeField);
  if (mode === 'raw') return;
  const changed =
    update.selectionSet ||
    update.docChanged ||
    update.startState.field(modeField) !== mode ||
    update.startState.field(blockField) !== state.field(blockField);
  if (!changed) return;
  const sel = state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return;
  const head = sel.main.head;
  const forward = update.changes.mapPos(update.startState.selection.main.head) <= head;
  const full = mode === 'full';

  let pos = head;
  for (let round = 0; round < 6; round++) {
    const start = pos;
    if (full) pos = afterLeadingAtoms(lineAtoms(state, pos), pos);
    const p = protectedAt(state, pos);
    if (p) {
      const after = p.to < state.doc.length ? p.to + 1 : -1;
      const before = p.from > 0 ? p.from - 1 : -1;
      const kind = p.value.kind;
      if (kind === 'table' || kind === 'frontmatter') {
        const next = forward ? (after >= 0 ? after : before) : before >= 0 ? before : after;
        if (next >= 0) pos = next;
      } else if (forward) {
        // Into the code from its opening fence, past the block from its closing fence.
        if (after >= 0 && (kind === 'fence-close' || p.value.after > 0)) pos = after;
      } else if (before >= 0) {
        pos = before;
      }
    }
    if (pos === start) break;
  }

  if (pos !== head) {
    update.view.dispatch({
      selection: EditorSelection.cursor(pos, 1),
      annotations: cursorFix.of(true),
      scrollIntoView: update.transactions.some((t) => t.scrollIntoView),
    });
  }
});

/** Arrow left/right at the end of the line next to a rendered table moves into its cells. */
function stepIntoTable(dir: 1 | -1): Command {
  return (view) => {
    const state = view.state;
    const head = singleCursor(view);
    if (head === null || state.field(modeField) === 'raw') return false;
    const line = state.doc.lineAt(head);
    if (dir > 0 ? head !== line.to || line.number >= state.doc.lines : head !== line.from || line.number <= 1) return false;
    const neighbour = state.doc.line(line.number + dir);
    const table = protectedAt(state, neighbour.from);
    if (table?.value.kind !== 'table') return false;
    return focusTableAt(view, table.from, dir > 0 ? 'first' : 'lastCell');
  };
}

export function editingBehaviour(): Extension {
  return [
    keepCursorSensible,
    Prec.high(
      keymap.of([
        { key: 'ArrowLeft', run: stepIntoTable(-1) },
        { key: 'ArrowRight', run: stepIntoTable(1) },
        { key: 'ArrowLeft', run: moveVisible(-1) },
        { key: 'ArrowRight', run: moveVisible(1) },
        { key: 'Backspace', run: deleteVisible(-1) },
        { key: 'Delete', run: deleteVisible(1) },
        { key: 'ArrowDown', run: enterTable(1) },
        { key: 'ArrowUp', run: enterTable(-1) },
      ]),
    ),
    keymap.of([
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Backspace', run: deleteMarkupBackward },
    ]),
  ];
}
