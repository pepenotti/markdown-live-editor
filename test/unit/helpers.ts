import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { markdownSupport } from '../../src/webview/markdown';

/**
 * Builds a state from text where `¦` marks a cursor and `⟦…⟧` a selection.
 */
export function stateOf(marked: string, extensions: Extension[] = [], options: { wikiLinks?: boolean } = {}): EditorState {
  let doc = '';
  let anchor = -1;
  let head = -1;
  for (const ch of marked) {
    if (ch === '¦') anchor = head = doc.length;
    else if (ch === '⟦') anchor = doc.length;
    else if (ch === '⟧') head = doc.length;
    else doc += ch;
  }
  const state = EditorState.create({
    doc,
    selection: anchor < 0 ? undefined : EditorSelection.single(anchor, head),
    extensions: [markdownSupport(options), EditorState.allowMultipleSelections.of(true), ...extensions],
  });
  ensureSyntaxTree(state, state.doc.length, 5000);
  return state;
}

/** Renders a state back into the marked notation. */
export function show(state: EditorState): string {
  const { from, to, empty } = state.selection.main;
  const text = state.doc.toString();
  if (empty) return text.slice(0, from) + '¦' + text.slice(from);
  return text.slice(0, from) + '⟦' + text.slice(from, to) + '⟧' + text.slice(to);
}

export function run(marked: string, command: (state: EditorState) => TransactionSpec | null): string {
  const state = stateOf(marked);
  const spec = command(state);
  if (!spec) return show(state);
  const next = state.update(spec).state;
  return show(next);
}
