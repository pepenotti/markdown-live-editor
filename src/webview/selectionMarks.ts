// The editor uses the browser's own selection, which every page in VS Code shows reliably.
// The browser can only show one selection, so further cursors and ranges (Alt+click,
// select all occurrences) are drawn here.
import { type EditorState, type Range } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view';

class CursorWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'mdl-extra-cursor';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}

const cursor = Decoration.widget({ widget: new CursorWidget(), side: 1 });
const range = Decoration.mark({ class: 'mdl-extra-selection' });

function build(state: EditorState): DecorationSet {
  const sel = state.selection;
  if (sel.ranges.length < 2) return Decoration.none;
  const decos: Range<Decoration>[] = [];
  sel.ranges.forEach((r, i) => {
    if (i === sel.mainIndex) return;
    decos.push(r.empty ? cursor.range(r.head) : range.range(r.from, r.to));
  });
  return Decoration.set(decos, true);
}

export const selectionMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view.state);
    }
    update(u: ViewUpdate): void {
      if (u.selectionSet || u.docChanged) this.decorations = build(u.state);
    }
  },
  { decorations: (v) => v.decorations },
);
