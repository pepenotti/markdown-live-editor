// Full preview hides link and image syntax, so a small popover next to the cursor
// shows the target and lets it be edited.
import { syntaxTree } from '@codemirror/language';
import { type EditorState, StateField } from '@codemirror/state';
import { type EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { encodeLinkPath } from './commands/format';
import { hostActions } from './config';
import { linkInfo, type LinkInfo } from './decorations/inline';
import { modeField } from './modes';

interface Target {
  node: SyntaxNode;
  kind: 'link' | 'image';
  info: LinkInfo;
}

/** The link whose text contains `pos`, or the image right next to it. */
export function linkTargetAt(state: EditorState, pos: number): Target | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name !== 'Link' && n.name !== 'Image') continue;
      const info = linkInfo(state, n);
      if (!info || info.href === null) continue;
      if (n.name === 'Image') return { node: n, kind: 'image', info };
      if (pos >= info.textFrom && pos <= info.textTo) return { node: n, kind: 'link', info };
    }
  }
  return null;
}

function compute(state: EditorState): Tooltip | null {
  if (state.field(modeField) !== 'full') return null;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return null;
  const target = linkTargetAt(state, sel.head);
  if (!target) return null;
  return { pos: target.node.from, end: target.node.to, above: false, arrow: false, create: createPopover };
}

export const popoverField = StateField.define<Tooltip | null>({
  create: compute,
  update(value, tr) {
    const unchanged =
      !tr.docChanged &&
      !tr.selection &&
      tr.startState.field(modeField) === tr.state.field(modeField) &&
      syntaxTree(tr.startState) === syntaxTree(tr.state);
    if (unchanged) return value;
    const next = compute(tr.state);
    return value && next && value.pos === next.pos && value.end === next.end ? value : next;
  },
  provide: (field) => showTooltip.from(field),
});

function current(view: EditorView): Target | null {
  return linkTargetAt(view.state, view.state.selection.main.head);
}

function setUrl(view: EditorView, value: string): void {
  const t = current(view);
  if (!t || !t.info.inline) return;
  const encoded = encodeLinkPath(value.trim());
  if (t.info.url) {
    view.dispatch({ changes: { from: t.info.url.from, to: t.info.url.to, insert: encoded }, userEvent: 'input.type' });
    return;
  }
  const open = t.node.getChildren('LinkMark')[2];
  if (open) view.dispatch({ changes: { from: open.to, insert: encoded }, userEvent: 'input.type' });
}

function setAlt(view: EditorView, value: string): void {
  const t = current(view);
  if (!t) return;
  view.dispatch({
    changes: { from: t.info.textFrom, to: t.info.textTo, insert: value.replace(/[\[\]\n]/g, ' ') },
    userEvent: 'input.type',
  });
}

function remove(view: EditorView): void {
  const t = current(view);
  if (!t) return;
  const insert = t.kind === 'link' ? view.state.doc.sliceString(t.info.textFrom, t.info.textTo) : '';
  view.dispatch({
    changes: { from: t.node.from, to: t.node.to, insert },
    selection: { anchor: t.node.from + insert.length },
    userEvent: 'input.format',
  });
  view.focus();
}

function field(label: string, name: string, placeholder: string): { row: HTMLElement; input: HTMLInputElement } {
  const row = document.createElement('label');
  row.className = 'cm-md-popover-row';
  const caption = document.createElement('span');
  caption.textContent = label;
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = placeholder;
  input.dataset.field = name;
  row.append(caption, input);
  return { row, input };
}

function button(label: string, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  b.title = title;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', run);
  return b;
}

function createPopover(view: EditorView): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'cm-md-popover';
  const alt = field('Alt text', 'alt', 'Describe the image');
  const url = field('Link', 'url', 'https://… or a file path');
  const note = document.createElement('div');
  note.className = 'cm-md-popover-note';
  const actions = document.createElement('div');
  actions.className = 'cm-md-popover-actions';

  const open = button('Open', 'Open the link', () => {
    const t = current(view);
    if (t?.info.href) view.state.facet(hostActions).openLink(t.info.href);
  });
  const browse = button('Choose file…', 'Choose an image file', () => {
    void view.state
      .facet(hostActions)
      .pickImages()
      .then((items) => {
        if (items[0]) setUrl(view, decodeLinkPath(items[0].path));
      });
  });
  const del = button('Remove', 'Remove', () => remove(view));
  actions.append(open, browse, del);
  dom.append(alt.row, url.row, note, actions);

  url.input.addEventListener('input', () => setUrl(view, url.input.value));
  alt.input.addEventListener('input', () => setAlt(view, alt.input.value));
  for (const input of [url.input, alt.input]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        view.focus();
      }
      e.stopPropagation();
    });
  }

  const render = () => {
    const t = current(view);
    if (!t) return;
    const image = t.kind === 'image';
    dom.dataset.kind = t.kind;
    alt.row.hidden = !image;
    browse.hidden = !image || !t.info.inline;
    open.hidden = image;
    del.textContent = image ? 'Remove image' : 'Remove link';
    url.row.firstElementChild!.textContent = image ? 'Image' : 'Link';
    url.input.readOnly = !t.info.inline;
    note.hidden = t.info.inline;
    note.textContent = 'Defined elsewhere in the document as a reference; switch to half preview to edit it.';
    if (document.activeElement !== url.input) url.input.value = t.info.href ?? '';
    if (document.activeElement !== alt.input) alt.input.value = view.state.doc.sliceString(t.info.textFrom, t.info.textTo);
  };
  render();
  return { dom, update: render };
}

function decodeLinkPath(path: string): string {
  return path.startsWith('<') && path.endsWith('>') ? path.slice(1, -1) : path;
}

/** Puts keyboard focus in the popover's target field, if a popover is showing. */
export function focusPopover(view: EditorView): void {
  requestAnimationFrame(() => {
    const input = view.dom.querySelector<HTMLInputElement>('.cm-md-popover input[data-field="url"]');
    if (input && !input.readOnly) {
      input.focus();
      input.select();
    }
  });
}
