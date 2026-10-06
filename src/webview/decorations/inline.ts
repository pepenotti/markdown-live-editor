// Inline rendering for the half and full preview modes. Syntax markers are hidden,
// text is styled, and small widgets (images, checkboxes, rules) are added.
//
// Half preview: markers of the element the cursor touches are shown so they can be edited.
// Full preview: markers stay hidden and are skipped by the cursor ("atoms").
import { foldable, foldedRanges, syntaxTree } from '@codemirror/language';
import { type EditorState, type Range, RangeSet, RangeValue } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { renderConfig } from '../config';
import { stripUrl } from '../inlineRender';
import { modeField, refreshDecorations } from '../modes';
import { AlertLabelWidget, CheckboxWidget, CodeHeaderWidget, FoldWidget, ImageWidget, isFoldedAt, RuleWidget } from '../widgets/simple';

/** inline: marker inside a line. leading: marker at the start of a line. line: a whole hidden line. */
export type AtomKind = 'inline' | 'leading' | 'line';

export interface AtomRange {
  from: number;
  to: number;
  kind: AtomKind;
}

class Atom extends RangeValue {
  constructor(readonly kind: AtomKind) {
    super();
  }
  override eq(other: Atom): boolean {
    return other.kind === this.kind;
  }
}
const ATOMS: Record<AtomKind, Atom> = { inline: new Atom('inline'), leading: new Atom('leading'), line: new Atom('line') };

interface Span {
  from: number;
  to: number;
}

export interface Collected {
  decorations: Range<Decoration>[];
  atoms: AtomRange[];
}

const HIDE = Decoration.replace({});
const markCache = new Map<string, Decoration>();
function markDeco(cls: string): Decoration {
  let d = markCache.get(cls);
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
}
const lineCache = new Map<string, Decoration>();
function lineDeco(cls: string, style?: string): Decoration {
  const key = style ? `${cls}|${style}` : cls;
  let d = lineCache.get(key);
  if (!d) {
    d = Decoration.line(style ? { class: cls, attributes: { style } } : { class: cls });
    if (lineCache.size > 500) lineCache.clear();
    lineCache.set(key, d);
  }
  return d;
}

const ALERT = /^\[!(note|tip|important|warning|caution)\]$/i;
/** "[ ]" is three characters in the source; the checkbox drawn for it is two wide (see .cm-md-checkbox). */
const CHECKBOX_SOURCE_WIDTH = 3;
const CHECKBOX_WIDTH = 2;
const IMG_TAG = /<img\b[^>]*>/gi;

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

const definitionCache = new WeakMap<Tree, Map<string, string>>();

/** Reference definitions (`[label]: url`) of the document. */
export function linkDefinitions(state: EditorState): Map<string, string> {
  const tree = syntaxTree(state);
  let defs = definitionCache.get(tree);
  if (defs) return defs;
  defs = new Map();
  const found = defs;
  tree.iterate({
    enter(node) {
      if (node.name === 'LinkReference') {
        const label = node.node.getChild('LinkLabel');
        const url = node.node.getChild('URL');
        if (label && url) {
          const key = normalizeLabel(state.doc.sliceString(label.from + 1, label.to - 1));
          if (!found.has(key)) found.set(key, stripUrl(state.doc.sliceString(url.from, url.to)));
        }
        return false;
      }
      return node.name === 'Document' || node.name === 'Blockquote' || node.name.endsWith('List') || node.name === 'ListItem';
    },
  });
  definitionCache.set(tree, defs);
  return defs;
}

export interface LinkInfo {
  /** Target, or null when the brackets are not a link at all. */
  href: string | null;
  /** Range of the visible text between the brackets. */
  textFrom: number;
  textTo: number;
  url: SyntaxNode | null;
  /** True for `[text](url)`, false for reference links. */
  inline: boolean;
}

/** Works out the target of a Link or Image node. */
export function linkInfo(state: EditorState, node: SyntaxNode): LinkInfo | null {
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null;
  const doc = state.doc;
  const url = node.getChild('URL');
  const inline = marks.length >= 3;
  const textFrom = marks[0].to;
  const textTo = marks[1].from;
  let href: string | null;
  if (inline) {
    href = url ? stripUrl(doc.sliceString(url.from, url.to)) : '';
  } else {
    const label = node.getChild('LinkLabel');
    const explicit = label ? doc.sliceString(label.from + 1, label.to - 1) : '';
    const key = normalizeLabel(explicit || doc.sliceString(textFrom, textTo));
    href = linkDefinitions(state).get(key) ?? null;
  }
  return { href, textFrom, textTo, url, inline };
}

/**
 * Builds the decorations for the given ranges of the document.
 * It only reads the state, so it also serves cursor logic that needs the atoms of one line.
 */
export function collectInline(state: EditorState, ranges: readonly Span[]): Collected {
  const out: Collected = { decorations: [], atoms: [] };
  const mode = state.field(modeField);
  if (mode === 'raw') return out;
  const full = mode === 'full';
  const doc = state.doc;
  const cfg = state.facet(renderConfig);
  const selection = state.selection.ranges;
  const decos = out.decorations;

  const touches = (from: number, to: number) => !full && selection.some((r) => r.from <= to && r.to >= from);
  const lineActive = (pos: number) => {
    if (full) return false;
    const line = doc.lineAt(pos);
    return selection.some((r) => r.from <= line.to && r.to >= line.from);
  };
  const atom = (from: number, to: number, kind: AtomKind) => {
    if (full && to > from) out.atoms.push({ from, to, kind });
  };
  const hide = (from: number, to: number, kind: AtomKind = 'inline') => {
    if (to <= from) return;
    decos.push(HIDE.range(from, to));
    atom(from, to, kind);
  };
  const mark = (cls: string, from: number, to: number, title?: string) => {
    if (to <= from) return;
    decos.push((title ? Decoration.mark({ class: cls, attributes: { title } }) : markDeco(cls)).range(from, to));
  };
  const hanging = (chars: number) => {
    const em = (chars * cfg.monoRatio).toFixed(3);
    return `padding-left: calc(var(--mdl-line-pad) + ${em}em); text-indent: -${em}em;`;
  };

  for (const range of ranges) {
    const eachLine = (from: number, to: number, f: (lineFrom: number, number: number, lineTo: number) => void) => {
      const a = Math.max(from, range.from);
      const b = Math.min(to, range.to);
      if (a > b) return;
      const last = doc.lineAt(b).number;
      for (let n = doc.lineAt(a).number; n <= last; n++) {
        const line = doc.line(n);
        f(line.from, n, line.to);
      }
    };

    syntaxTree(state).iterate({
      from: range.from,
      to: range.to,
      enter(ref) {
        const name = ref.name;
        const from = ref.from;
        const to = ref.to;
        switch (name) {
          case 'ATXHeading1':
          case 'ATXHeading2':
          case 'ATXHeading3':
          case 'ATXHeading4':
          case 'ATXHeading5':
          case 'ATXHeading6': {
            const line = doc.lineAt(from);
            decos.push(lineDeco(`cm-md-h cm-md-h${name.slice(-1)}`).range(line.from));
            if (from === line.from && foldable(state, line.from, line.to)) {
              decos.push(Decoration.widget({ widget: new FoldWidget(isFoldedAt({ state }, line.to)), side: -1 }).range(line.from));
            }
            return true;
          }

          case 'SetextHeading1':
          case 'SetextHeading2': {
            const mark2 = ref.node.getChild('HeaderMark');
            const lastText = mark2 ? doc.lineAt(mark2.from).from - 1 : to;
            eachLine(from, Math.max(from, lastText), (lineFrom) => decos.push(lineDeco(`cm-md-h cm-md-h${name.slice(-1)}`).range(lineFrom)));
            return true;
          }

          case 'HeaderMark': {
            const parent = ref.node.parent;
            if (!parent) return false;
            if (parent.name.startsWith('ATX')) {
              const line = doc.lineAt(from);
              if (lineActive(from)) {
                mark('cm-md-mark', from, to);
              } else if (from === parent.from) {
                let end = to;
                while (end < line.to && /[ \t]/.test(doc.sliceString(end, end + 1))) end++;
                hide(from, end, 'leading');
              } else {
                let start = from;
                while (start > parent.from && /[ \t]/.test(doc.sliceString(start - 1, start))) start--;
                hide(start, to);
              }
            } else if (full) {
              hide(from, to, 'line');
            } else {
              mark('cm-md-mark', from, to);
            }
            return false;
          }

          case 'Emphasis':
            mark('cm-md-em', from, to);
            return true;
          case 'StrongEmphasis':
            mark('cm-md-strong', from, to);
            return true;
          case 'Strikethrough':
            mark('cm-md-strike', from, to);
            return true;

          case 'EmphasisMark':
          case 'StrikethroughMark': {
            const parent = ref.node.parent;
            if (parent && touches(parent.from, parent.to)) mark('cm-md-mark', from, to);
            else hide(from, to);
            return false;
          }

          case 'InlineCode': {
            const open = ref.node.firstChild;
            const close = ref.node.lastChild;
            mark('cm-md-code', from, to);
            if (open && close && open !== close && open.name === 'CodeMark' && close.name === 'CodeMark') {
              if (touches(from, to)) {
                mark('cm-md-mark', open.from, open.to);
                mark('cm-md-mark', close.from, close.to);
              } else {
                hide(open.from, open.to);
                hide(close.from, close.to);
              }
            }
            return false;
          }

          case 'Link': {
            const node = ref.node;
            const text = doc.sliceString(from, to);
            const alert = ALERT.exec(text);
            if (alert && node.parent?.name === 'Paragraph' && node.parent.from === from && node.parent.parent?.name === 'Blockquote') {
              if (lineActive(from)) mark('cm-md-mark', from, to);
              else {
                decos.push(Decoration.replace({ widget: new AlertLabelWidget(alert[1]) }).range(from, to));
                atom(from, to, 'inline');
              }
              return false;
            }
            const info = linkInfo(state, node);
            if (!info || info.href === null) return true;
            const marks = node.getChildren('LinkMark');
            mark('cm-md-link', info.textFrom, info.textTo, info.href || undefined);
            if (touches(from, to)) {
              mark('cm-md-mark', marks[0].from, marks[0].to);
              mark('cm-md-mark cm-md-url', marks[1].from, to);
            } else {
              hide(marks[0].from, marks[0].to);
              hide(marks[1].from, to);
            }
            return true;
          }

          case 'Image': {
            const info = linkInfo(state, ref.node);
            if (!info || info.href === null) return false;
            const titleNode = ref.node.getChild('LinkTitle');
            const title = titleNode ? doc.sliceString(titleNode.from + 1, titleNode.to - 1) : '';
            const shown = touches(from, to);
            if (shown) mark('cm-md-mark cm-md-image-source', from, to);
            else hide(from, to);
            const widget = new ImageWidget(info.href, cfg.resolveUrl(info.href), doc.sliceString(info.textFrom, info.textTo), title, shown);
            // In full preview the cursor can sit before or after the picture; in half
            // preview it stays with the source text and the picture follows it.
            decos.push(Decoration.widget({ widget, side: full ? -1 : 1 }).range(to));
            return false;
          }

          case 'Autolink': {
            const url = ref.node.getChild('URL');
            if (url) mark('cm-md-link', url.from, url.to, doc.sliceString(url.from, url.to));
            const shown = touches(from, to);
            for (const m of ref.node.getChildren('LinkMark')) {
              if (shown) mark('cm-md-mark', m.from, m.to);
              else hide(m.from, m.to);
            }
            return false;
          }

          case 'URL': {
            const parent = ref.node.parent?.name;
            if (parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference' && parent !== 'Autolink') {
              mark('cm-md-link', from, to, doc.sliceString(from, to));
            }
            return false;
          }

          case 'LinkReference':
            mark('cm-md-mark', from, to);
            return false;

          case 'Escape':
            if (touches(from, to)) mark('cm-md-mark', from, from + 1);
            else hide(from, from + 1);
            return false;

          case 'Blockquote': {
            let nested = false;
            for (let p = ref.node.parent; p; p = p.parent) if (p.name === 'Blockquote') nested = true;
            const firstLine = doc.lineAt(from);
            const alert = /^\s*>\s*\[!(note|tip|important|warning|caution)\]\s*$/i.exec(firstLine.text);
            const cls = 'cm-md-quote' + (nested ? ' cm-md-quote-nested' : '') + (alert ? ` cm-md-alert cm-md-alert-${alert[1].toLowerCase()}` : '');
            eachLine(from, to, (lineFrom) => decos.push(lineDeco(cls).range(lineFrom)));
            return true;
          }

          case 'QuoteMark': {
            if (lineActive(from)) {
              mark('cm-md-mark', from, to);
            } else {
              const end = doc.sliceString(to, to + 1) === ' ' ? to + 1 : to;
              hide(from, end, 'leading');
            }
            return false;
          }

          case 'ListItem':
            listItem(ref.node);
            return true;

          case 'ListMark':
          case 'TaskMarker':
          case 'LinkMark':
          case 'LinkLabel':
          case 'LinkTitle':
          case 'CodeMark':
          case 'CodeInfo':
          case 'CodeText':
            return false;

          case 'HorizontalRule':
            if (lineActive(from)) mark('cm-md-mark', from, to);
            else {
              decos.push(Decoration.replace({ widget: new RuleWidget() }).range(from, to));
              atom(from, to, 'line');
            }
            return false;

          case 'FencedCode':
            fencedCode(ref.node);
            return false;

          case 'CodeBlock':
            eachLine(from, to, (lineFrom) => decos.push(lineDeco('cm-md-codeblock cm-md-codeblock-indented').range(lineFrom)));
            return false;

          case 'HTMLBlock':
          case 'HTMLTag': {
            if (name === 'HTMLBlock') eachLine(from, to, (lineFrom) => decos.push(lineDeco('cm-md-html').range(lineFrom)));
            else mark('cm-md-html', from, to);
            const text = doc.sliceString(from, to);
            IMG_TAG.lastIndex = 0;
            for (let m = IMG_TAG.exec(text); m; m = IMG_TAG.exec(text)) {
              const src = attr(m[0], 'src');
              const end = from + m.index + m[0].length;
              if (src && end >= range.from && end <= range.to) {
                const widget = new ImageWidget(src, cfg.resolveUrl(src), attr(m[0], 'alt'), attr(m[0], 'title'), true, attr(m[0], 'width'));
                decos.push(Decoration.widget({ widget, side: -1 }).range(end));
              }
            }
            return false;
          }

          case 'CommentBlock':
          case 'Comment':
            mark('cm-md-mark', from, to);
            return false;

          case 'Table':
            eachLine(from, to, (lineFrom) => decos.push(lineDeco('cm-md-table-source').range(lineFrom)));
            return false;

          case 'FrontMatter': {
            const first = doc.lineAt(from).number;
            const last = doc.lineAt(to).number;
            eachLine(from, to, (lineFrom, n) =>
              decos.push(
                lineDeco('cm-md-frontmatter' + (n === first ? ' cm-md-frontmatter-first' : '') + (n === last ? ' cm-md-frontmatter-last' : '')).range(lineFrom),
              ),
            );
            return false;
          }

          default:
            return true;
        }
      },
    });

    function listItem(node: SyntaxNode): void {
      const markNode = node.getChild('ListMark');
      if (!markNode) return;
      const line = doc.lineAt(node.from);
      const ordered = node.parent?.name === 'OrderedList';
      const task = node.getChild('Task');
      const taskMarker = task?.getChild('TaskMarker') ?? null;

      // The prefix is everything before the item's text: indentation, marker, checkbox.
      let prefixStart = markNode.from;
      while (prefixStart > line.from && /[ \t]/.test(doc.sliceString(prefixStart - 1, prefixStart))) prefixStart--;
      let prefixEnd: number;
      if (taskMarker) {
        prefixEnd = doc.sliceString(taskMarker.to, taskMarker.to + 1) === ' ' ? taskMarker.to + 1 : taskMarker.to;
      } else {
        prefixEnd = markNode.to;
        while (prefixEnd < line.to && prefixEnd - markNode.to < 4 && doc.sliceString(prefixEnd, prefixEnd + 1) === ' ') prefixEnd++;
        if (prefixEnd === line.to && prefixEnd > markNode.to + 1) prefixEnd = markNode.to + 1;
      }
      const contentIndent = markNode.to + 1 - line.from;
      const prefixText = doc.sliceString(line.from, prefixEnd);
      const simple = prefixStart === line.from && !prefixText.includes('\t');

      if (line.to >= range.from && line.from <= range.to) {
        const markTouched = touches(markNode.from, markNode.to);
        const boxShown = !!taskMarker && !touches(taskMarker.from, taskMarker.to);
        // A task shows only its checkbox, so its "- " is dropped unless the cursor is on it.
        const markEnd = doc.sliceString(markNode.to, markNode.to + 1) === ' ' ? markNode.to + 1 : markNode.to;
        const markHidden = !!taskMarker && !markTouched;
        // Width of the visible prefix in fixed-width characters, for the hanging indent.
        let width = prefixEnd - line.from;
        if (markHidden) width -= markEnd - markNode.from;
        if (boxShown) width -= CHECKBOX_SOURCE_WIDTH - CHECKBOX_WIDTH;

        mark('cm-md-list-prefix', prefixStart, prefixEnd);
        if (simple) decos.push(lineDeco('cm-md-li', hanging(width)).range(line.from));
        atom(prefixStart, prefixEnd, 'leading');
        if (markHidden) decos.push(HIDE.range(markNode.from, markEnd));
        else if (ordered) mark('cm-md-ordinal', markNode.from, markNode.to);
        else if (markTouched) mark('cm-md-mark', markNode.from, markNode.to);
        else mark('cm-md-bullet', markNode.from, markNode.to);
        if (taskMarker && task) {
          const checked = /[xX]/.test(doc.sliceString(taskMarker.from, taskMarker.to));
          if (boxShown) decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(taskMarker.from, taskMarker.to));
          else mark('cm-md-mark', taskMarker.from, taskMarker.to);
          if (checked) mark('cm-md-task-done', Math.min(prefixEnd, task.to), Math.min(task.to, line.to));
        }
      }

      // Later lines of the same item: draw their indentation in the same fixed-width font.
      const lastLine = doc.lineAt(node.to).number;
      if (lastLine === line.number) return;
      const nested: Span[] = [];
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'BulletList' || child.name === 'OrderedList') nested.push({ from: doc.lineAt(child.from).from, to: child.to });
      }
      eachLine(line.to + 1, node.to, (lineFrom, _n, lineTo) => {
        if (nested.some((s) => lineFrom >= s.from && lineFrom <= s.to)) return;
        const text = doc.sliceString(lineFrom, lineTo);
        const spaces = Math.min(/^ */.exec(text)![0].length, contentIndent);
        if (spaces === 0 || spaces === text.length) return;
        mark('cm-md-list-prefix', lineFrom, lineFrom + spaces);
        decos.push(lineDeco('cm-md-li', hanging(spaces)).range(lineFrom));
        atom(lineFrom, lineFrom + spaces, 'leading');
      });
    }

    function fencedCode(node: SyntaxNode): void {
      const first = doc.lineAt(node.from);
      const last = doc.lineAt(node.to);
      const marks = node.getChildren('CodeMark');
      const closeMark = marks.length >= 2 ? marks[marks.length - 1] : null;
      const closed = !!closeMark && last.number > first.number && closeMark.from >= last.from;
      const shown = touches(node.from, node.to);
      eachLine(node.from, node.to, (lineFrom, n) => {
        let cls = 'cm-md-codeblock';
        if (n === first.number) cls += ' cm-md-codeblock-first';
        if (n === last.number) cls += ' cm-md-codeblock-last';
        if (!shown && closed && n === last.number) cls += ' cm-md-fence-hidden';
        decos.push(lineDeco(cls).range(lineFrom));
      });
      const visible = (line: { from: number; to: number }) => line.to >= range.from && line.from <= range.to;
      if (visible(first)) {
        if (shown) mark('cm-md-mark', node.from, first.to);
        else {
          const info = node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim().split(/\s+/)[0] : '';
          decos.push(Decoration.replace({ widget: new CodeHeaderWidget(lang) }).range(node.from, first.to));
          atom(node.from, first.to, 'line');
        }
      }
      if (closed && closeMark && visible(last)) {
        if (shown) mark('cm-md-mark', closeMark.from, last.to);
        else hide(closeMark.from, last.to, 'line');
      }
    }
  }
  return out;
}

/** Atoms of the line that contains `pos`. Empty outside full preview. */
export function lineAtoms(state: EditorState, pos: number): AtomRange[] {
  if (state.field(modeField) !== 'full') return [];
  const line = state.doc.lineAt(pos);
  return collectInline(state, [{ from: line.from, to: line.to }]).atoms;
}

/** End of the hidden line-start markers at `pos`, or `pos` itself when there are none. */
export function afterLeadingAtoms(atoms: readonly AtomRange[], pos: number): number {
  let p = pos;
  for (;;) {
    const a = atoms.find((x) => x.kind === 'leading' && x.from <= p && p < x.to);
    if (!a) return p;
    p = a.to;
  }
}

function buildSets(state: EditorState, ranges: readonly Span[]): { decorations: DecorationSet; atomic: RangeSet<Atom> } {
  const c = collectInline(state, ranges);
  return {
    decorations: Decoration.set(c.decorations, true),
    atomic: RangeSet.of(
      c.atoms.map((a) => ATOMS[a.kind].range(a.from, a.to)),
      true,
    ),
  };
}

export const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none;
    atomic: RangeSet<Atom> = RangeSet.empty;

    constructor(view: EditorView) {
      this.build(view);
    }

    update(u: ViewUpdate): void {
      const mode = u.state.field(modeField);
      const modeChanged = u.startState.field(modeField) !== mode;
      const forced = u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshDecorations)));
      const treeChanged = syntaxTree(u.startState) !== syntaxTree(u.state);
      const configChanged = u.startState.facet(renderConfig) !== u.state.facet(renderConfig) || foldedRanges(u.startState) !== foldedRanges(u.state);
      // Only half preview depends on where the cursor is.
      const selectionMatters = u.selectionSet && mode === 'half';
      if (u.docChanged || u.viewportChanged || modeChanged || forced || treeChanged || configChanged || selectionMatters) this.build(u.view);
    }

    build(view: EditorView): void {
      const sets = buildSets(view.state, view.visibleRanges);
      this.decorations = sets.decorations;
      this.atomic = sets.atomic;
    }
  },
  {
    decorations: (v) => v.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.atomic ?? RangeSet.empty),
  },
);
