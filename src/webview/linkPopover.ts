// Full preview hides the syntax of links, images and inline math, so a small popover
// next to the cursor shows what is hidden and lets it be edited.
import { syntaxTree } from '@codemirror/language';
import { type EditorState, StateField } from '@codemirror/state';
import { type EditorView, showTooltip, type Tooltip, type TooltipView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { encodeLinkPath } from './commands/format';
import { hostActions } from './config';
import { getAttr, isLoneImg, setAttr } from './htmlTag';
import { linkInfo, type LinkInfo } from './links';
import { texOf, withTex } from './markdown';
import { modeField } from './modes';

export type Target =
  | { kind: 'link' | 'image'; from: number; to: number; node: SyntaxNode; info: LinkInfo }
  /** An image written as an `<img>` tag. */
  | { kind: 'tag'; from: number; to: number; tag: string }
  | { kind: 'math'; from: number; to: number; source: string };

/** The link whose text contains `pos`, or the image or formula right next to it. */
export function popoverTargetAt(state: EditorState, pos: number): Target | null {
  for (const side of [-1, 1] as const) {
    for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === 'InlineMath') return { kind: 'math', from: n.from, to: n.to, source: state.doc.sliceString(n.from, n.to) };
      if (n.name === 'HTMLTag' || n.name === 'HTMLBlock') {
        const tag = state.doc.sliceString(n.from, n.to);
        if (isLoneImg(tag) && getAttr(tag, 'src') !== '') return { kind: 'tag', from: n.from, to: n.to, tag };
        continue;
      }
      if (n.name !== 'Link' && n.name !== 'Image') continue;
      const info = linkInfo(state, n);
      if (!info || info.href === null) continue;
      if (n.name === 'Image') return { kind: 'image', from: n.from, to: n.to, node: n, info };
      if (pos >= info.textFrom && pos <= info.textTo) return { kind: 'link', from: n.from, to: n.to, node: n, info };
    }
  }
  return null;
}

function compute(state: EditorState): Tooltip | null {
  if (state.field(modeField) !== 'full') return null;
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) return null;
  const target = popoverTargetAt(state, sel.head);
  if (!target) return null;
  return { pos: target.from, end: target.to, above: false, arrow: false, create: createPopover };
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
  return popoverTargetAt(view.state, view.state.selection.main.head);
}

interface Change {
  from: number;
  to: number;
  insert: string;
}

/** Replaces `before` (at `from`) by `after`, touching only the part that differs so the cursor stays put. */
function replaceText(from: number, before: string, after: string): Change | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: from + start, to: from + before.length - end, insert: after.slice(start, after.length - end) };
}

/** The change that points a link or image at another target. Reference links change their definition. */
export function urlChange(state: EditorState, t: Target, value: string): Change | null {
  if (t.kind === 'math') return null;
  if (t.kind === 'tag') return replaceText(t.from, t.tag, setAttr(t.tag, 'src', value.trim()));
  const encoded = encodeLinkPath(value.trim());
  if (!t.info.inline) {
    const def = t.info.definition;
    // A definition needs something after the colon; `<>` is an empty target.
    return def ? replaceText(def.from, state.doc.sliceString(def.from, def.to), encoded || '<>') : null;
  }
  if (t.info.url) return { from: t.info.url.from, to: t.info.url.to, insert: encoded };
  const open = t.node.getChildren('LinkMark')[2];
  return open ? { from: open.to, to: open.to, insert: encoded } : null;
}

/** The change that puts other TeX between the dollar signs, or null when it would not be a formula. */
export function texChange(t: Target, value: string): Change | null {
  if (t.kind !== 'math') return null;
  const next = withTex(t.source, value);
  return next === null ? null : replaceText(t.from, t.source, next);
}

function edit(view: EditorView, change: Change | null): void {
  if (change) view.dispatch({ changes: change, userEvent: 'input.type' });
}

function setUrl(view: EditorView, value: string): void {
  const t = current(view);
  if (t) edit(view, urlChange(view.state, t, value));
}

function setAlt(view: EditorView, value: string): void {
  const t = current(view);
  if (!t || t.kind === 'math') return;
  if (t.kind === 'tag') edit(view, replaceText(t.from, t.tag, setAttr(t.tag, 'alt', value.replace(/\n/g, ' '))));
  else edit(view, { from: t.info.textFrom, to: t.info.textTo, insert: value.replace(/[\[\]\n]/g, ' ') });
}

function remove(view: EditorView): void {
  const t = current(view);
  if (!t) return;
  const insert = t.kind === 'link' ? view.state.doc.sliceString(t.info.textFrom, t.info.textTo) : '';
  view.dispatch({
    changes: { from: t.from, to: t.to, insert },
    selection: { anchor: t.from + insert.length },
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

const REMOVE_LABEL: Record<Target['kind'], string> = { link: 'Remove link', image: 'Remove image', tag: 'Remove image', math: 'Remove formula' };

function createPopover(view: EditorView): TooltipView {
  const dom = document.createElement('div');
  dom.className = 'cm-md-popover';
  const alt = field('Alt text', 'alt', 'Describe the image');
  const url = field('Link', 'url', 'https://… or a file path');
  const tex = field('TeX', 'tex', 'x^2 + y^2');
  const note = document.createElement('div');
  note.className = 'cm-md-popover-note';
  const actions = document.createElement('div');
  actions.className = 'cm-md-popover-actions';

  const open = button('Open', 'Open the link', () => {
    const t = current(view);
    if (t?.kind === 'link' && t.info.href) view.state.facet(hostActions).openLink(t.info.href);
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
  dom.append(alt.row, url.row, tex.row, note, actions);

  url.input.addEventListener('input', () => setUrl(view, url.input.value));
  alt.input.addEventListener('input', () => setAlt(view, alt.input.value));
  tex.input.addEventListener('input', () => {
    const t = current(view);
    if (!t) return;
    const valid = withTex('$', tex.input.value) !== null;
    tex.input.setAttribute('aria-invalid', String(!valid));
    edit(view, texChange(t, tex.input.value));
    render();
  });
  tex.input.addEventListener('blur', () => {
    tex.input.setAttribute('aria-invalid', 'false');
    render();
  });
  for (const input of [url.input, alt.input, tex.input]) {
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
    const image = t.kind === 'image' || t.kind === 'tag';
    const math = t.kind === 'math';
    const reference = (t.kind === 'link' || t.kind === 'image') && !t.info.inline;
    dom.dataset.kind = t.kind;
    alt.row.hidden = !image;
    url.row.hidden = math;
    tex.row.hidden = !math;
    browse.hidden = !image;
    open.hidden = t.kind !== 'link';
    del.textContent = REMOVE_LABEL[t.kind];
    url.row.firstElementChild!.textContent = image ? 'Image' : 'Link';
    const invalid = math && tex.input.getAttribute('aria-invalid') === 'true';
    note.hidden = !reference && !invalid;
    if (invalid) note.textContent = 'A formula cannot be empty, contain a $ or end with a backslash. The document keeps the last valid one.';
    else if (reference) note.textContent = 'This is a reference: editing it changes its definition, which other links may share.';
    const active = document.activeElement;
    if (t.kind === 'math') {
      if (active !== tex.input) tex.input.value = texOf(t.source);
      return;
    }
    const href = t.kind === 'tag' ? getAttr(t.tag, 'src') : (t.info.href ?? '');
    const text = t.kind === 'tag' ? getAttr(t.tag, 'alt') : view.state.doc.sliceString(t.info.textFrom, t.info.textTo);
    if (active !== url.input) url.input.value = href;
    if (active !== alt.input) alt.input.value = text;
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
