// Block-level rendering: tables and collapsed front matter replace their source
// lines, so they have to come from a state field rather than a view plugin.
// The field also records which source lines must not be broken by typing next to them.
import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, RangeSet, RangeValue, StateField, type Text } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { findTocMarkers, isTocMarker } from '../../shared/toc';
import { modeField, refreshDecorations, revealBlock } from '../modes';
import { texOf } from '../markdown';
import { MathWidget, MermaidWidget } from '../widgets/rendered';
import { TableWidget } from '../widgets/table';

/**
 * rendered: a diagram or math block drawn in place of its source.
 * hidden: a line that is not shown at all (a table of contents marker in full preview).
 */
export type ProtectedKind = 'table' | 'frontmatter' | 'rendered' | 'hidden' | 'fence-open' | 'fence-close';

/** Whole source lines that are drawn as a widget and must stay intact. */
export class Protected extends RangeValue {
  constructor(
    readonly kind: ProtectedKind,
    /** How far the element these lines belong to extends before and after the range. */
    readonly before: number,
    readonly after: number,
  ) {
    super();
  }
  override eq(other: Protected): boolean {
    return other.kind === this.kind && other.before === this.before && other.after === this.after;
  }
}

export interface BlockState {
  decorations: DecorationSet;
  protected: RangeSet<Protected>;
  revealPos: number | null;
}

class FrontMatterWidget extends WidgetType {
  constructor(readonly fields: number) {
    super();
  }
  override eq(other: FrontMatterWidget): boolean {
    return other.fields === this.fields;
  }
  override get estimatedHeight(): number {
    return 34;
  }
  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-md-frontmatter-chip';
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.textContent = `Front matter · ${this.fields} ${this.fields === 1 ? 'field' : 'fields'}`;
    button.title = 'Show the front matter';
    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', () => {
      const pos = view.posAtDOM(dom);
      const line = view.state.doc.lineAt(pos);
      const inside = Math.min(view.state.doc.length, line.to + 1);
      view.dispatch({ effects: revealBlock.of(pos), selection: { anchor: inside } });
      view.focus();
    });
    dom.append(button);
    return dom;
  }
  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Decorations are rebuilt on every change, but almost every table is unchanged from
 * one build to the next, so parsed widgets are kept by their source text.
 */
const widgetCache = new Map<string, TableWidget>();
function tableWidget(source: string): TableWidget {
  let widget = widgetCache.get(source);
  if (widget) return widget;
  widget = new TableWidget(source);
  if (widgetCache.size >= 400) widgetCache.clear();
  widgetCache.set(source, widget);
  return widget;
}

function wholeLines(doc: Text, from: number, to: number): boolean {
  return doc.lineAt(from).from === from && doc.lineAt(to).to === to;
}

/** The source of a fenced code block when it is a closed Mermaid diagram, else null. */
function mermaidSource(state: EditorState, node: SyntaxNode): string | null {
  const info = node.getChild('CodeInfo');
  if (!info || state.doc.sliceString(info.from, info.to).trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return null;
  const marks = node.getChildren('CodeMark');
  const first = state.doc.lineAt(node.from);
  const last = state.doc.lineAt(node.to);
  if (marks.length < 2 || last.number === first.number || marks[marks.length - 1].from < last.from) return null;
  const body = node.getChild('CodeText');
  return body ? state.doc.sliceString(body.from, body.to) : '';
}

/** The block containing `pos` that is drawn in place of its source, if any. */
function revealableAt(state: EditorState, pos: number): SyntaxNode | null {
  if (pos > state.doc.length) return null;
  for (const side of [1, -1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'Table' || n.name === 'FrontMatter' || n.name === 'BlockMath') return n;
      if (n.name === 'FencedCode' && mermaidSource(state, n) !== null) return n;
    }
  }
  return null;
}

function build(state: EditorState, reveal: number | null): BlockState {
  const mode = state.field(modeField);
  if (mode === 'raw') return { decorations: Decoration.none, protected: RangeSet.empty, revealPos: reveal };
  const full = mode === 'full';
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const prot: Range<Protected>[] = [];
  const revealed = (from: number, to: number) => reveal !== null && reveal >= from && reveal <= to;
  /** Whole-line comments that read as table of contents markers. */
  const markerLines: { from: number; to: number }[] = [];

  syntaxTree(state).iterate({
    enter(node) {
      switch (node.name) {
        case 'Document':
          return true;
        case 'Table': {
          if (!wholeLines(doc, node.from, node.to) || revealed(node.from, node.to)) return false;
          const widget = tableWidget(doc.sliceString(node.from, node.to));
          if (!widget.model) return false;
          decos.push(Decoration.replace({ widget, block: true }).range(node.from, node.to));
          prot.push(new Protected('table', 0, 0).range(node.from, node.to));
          return false;
        }
        case 'FrontMatter': {
          if (!full || revealed(node.from, node.to) || node.to <= node.from) return false;
          const text = doc.sliceString(node.from, node.to);
          const fields = text.split('\n').filter((l) => /^[A-Za-z_][\w .-]*:/.test(l)).length;
          decos.push(Decoration.replace({ widget: new FrontMatterWidget(fields), block: true }).range(node.from, node.to));
          prot.push(new Protected('frontmatter', 0, 0).range(node.from, node.to));
          return false;
        }
        case 'BlockMath': {
          if (!wholeLines(doc, node.from, node.to)) return false;
          const tex = texOf(doc.sliceString(node.from, node.to));
          if (revealed(node.from, node.to)) {
            // While the source is being edited, the result is shown under it.
            decos.push(Decoration.widget({ widget: new MathWidget(tex, true), block: true, side: 1 }).range(node.to));
          } else {
            decos.push(Decoration.replace({ widget: new MathWidget(tex, true, true), block: true }).range(node.from, node.to));
            prot.push(new Protected('rendered', 0, 0).range(node.from, node.to));
          }
          return false;
        }
        case 'FencedCode': {
          const diagram = wholeLines(doc, node.from, node.to) ? mermaidSource(state, node.node) : null;
          if (diagram !== null) {
            if (!revealed(node.from, node.to)) {
              decos.push(Decoration.replace({ widget: new MermaidWidget(diagram, true), block: true }).range(node.from, node.to));
              prot.push(new Protected('rendered', 0, 0).range(node.from, node.to));
              return false;
            }
            decos.push(Decoration.widget({ widget: new MermaidWidget(diagram, false), block: true, side: 1 }).range(node.to));
          }
          if (!full) return false;
          const first = doc.lineAt(node.from);
          const last = doc.lineAt(node.to);
          if (last.number === first.number) return false;
          prot.push(new Protected('fence-open', 0, node.to - first.to).range(first.from, first.to));
          const marks = node.node.getChildren('CodeMark');
          const close = marks[marks.length - 1];
          if (marks.length >= 2 && close.from >= last.from && last.to > last.from) {
            prot.push(new Protected('fence-close', last.from - first.from, 0).range(last.from, last.to));
          }
          return false;
        }
        case 'CommentBlock': {
          // The two comments around a table of contents are bookkeeping, not content.
          if (!full || !wholeLines(doc, node.from, node.to) || !isTocMarker(doc.sliceString(node.from, node.to))) return false;
          markerLines.push({ from: node.from, to: node.to });
          return false;
        }
        case 'BulletList':
        case 'OrderedList':
        case 'ListItem':
        case 'Blockquote':
          return full;
        default:
          return false;
      }
    },
  });

  if (markerLines.length >= 2) {
    // Only the pair that is kept up to date is hidden. A marker without its partner, or a
    // second pair, stays visible so it can be seen and removed.
    const pair = findTocMarkers(doc.toString());
    for (const m of markerLines) {
      const line = doc.lineAt(m.from).number - 1;
      if (!pair || (line !== pair.startLine && line !== pair.endLine)) continue;
      decos.push(Decoration.replace({ block: true }).range(m.from, m.to));
      prot.push(new Protected('hidden', 0, 0).range(m.from, m.to));
    }
  }

  return { decorations: Decoration.set(decos, true), protected: RangeSet.of(prot, true), revealPos: reveal };
}

export const blockField = StateField.define<BlockState>({
  create: (state) => build(state, null),
  update(value, tr) {
    let reveal = value.revealPos === null ? null : tr.changes.mapPos(value.revealPos);
    let forced = false;
    for (const e of tr.effects) {
      if (e.is(revealBlock)) reveal = e.value;
      if (e.is(refreshDecorations)) forced = true;
    }
    if (reveal !== null) {
      // The source stays visible only while the cursor is inside the block.
      const block = revealableAt(tr.state, reveal);
      const head = tr.state.selection.main.head;
      if (!block || head < block.from || head > block.to) reveal = null;
      else reveal = block.from;
    }
    const changed =
      forced ||
      tr.docChanged ||
      reveal !== value.revealPos ||
      tr.startState.field(modeField) !== tr.state.field(modeField) ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state);
    return changed ? build(tr.state, reveal) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
});

/** The protected range whose lines contain `pos`, if any. */
export function protectedAt(state: EditorState, pos: number): { from: number; to: number; value: Protected } | null {
  let found: { from: number; to: number; value: Protected } | null = null;
  state.field(blockField).protected.between(pos, pos, (from, to, value) => {
    if (pos >= from && pos <= to) found = { from, to, value };
  });
  return found;
}
