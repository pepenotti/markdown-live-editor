// Small inline widgets: images, checkboxes, rules, code block headers.
import { foldable, foldedRanges, foldEffect, syntaxTree, unfoldEffect } from '@codemirror/language';
import { type EditorView, WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { MIN_IMAGE_WIDTH, resizeImage } from '../commands/image';

function cssWidth(width: string): string {
  return /^\d+$/.test(width) ? `${width}px` : width;
}

/** Dragging the handle changes the picture's width; the document is edited once, on release. */
function resizeOnDrag(handle: HTMLElement, wrap: HTMLElement, img: HTMLImageElement, view: EditorView): void {
  handle.addEventListener('mousedown', (down) => {
    if (down.button !== 0) return;
    down.preventDefault();
    down.stopPropagation();
    const start = img.getBoundingClientRect().width;
    let moved = false;
    wrap.classList.add('cm-md-image-resizing');
    const move = (e: MouseEvent) => {
      moved = true;
      img.style.width = `${Math.max(MIN_IMAGE_WIDTH, Math.round(start + e.clientX - down.clientX))}px`;
      view.requestMeasure();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      wrap.classList.remove('cm-md-image-resizing');
      // The picture never grows past the text column, so read back what it really got.
      const width = Math.round(img.getBoundingClientRect().width);
      const change = moved && width !== Math.round(start) && wrap.isConnected ? resizeImage(view.state, view.posAtDOM(wrap), width) : null;
      if (change) {
        view.dispatch({ changes: change, userEvent: 'input.format' });
      } else {
        const before = wrap.dataset.width ?? '';
        if (before) img.style.width = cssWidth(before);
        else img.style.removeProperty('width');
        view.requestMeasure();
      }
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly url: string,
    readonly alt: string,
    readonly title: string,
    /** Shown under its own source text rather than in place of it. */
    readonly below: boolean,
    readonly width = '',
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.url === this.url &&
      other.src === this.src &&
      other.alt === this.alt &&
      other.title === this.title &&
      other.below === this.below &&
      other.width === this.width
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    const img = document.createElement('img');
    img.draggable = false;
    img.addEventListener('load', () => {
      wrap.classList.remove('cm-md-image-error');
      view.requestMeasure();
    });
    img.addEventListener('error', () => {
      wrap.classList.add('cm-md-image-error');
      view.requestMeasure();
    });
    const frame = document.createElement('span');
    frame.className = 'cm-md-image-frame';
    const handle = document.createElement('span');
    handle.className = 'cm-md-image-handle';
    handle.title = 'Drag to resize';
    resizeOnDrag(handle, wrap, img, view);
    frame.append(img, handle);
    const label = document.createElement('span');
    label.className = 'cm-md-image-missing';
    wrap.append(frame, label);
    this.apply(wrap);
    return wrap;
  }

  override updateDOM(dom: HTMLElement): boolean {
    if (!dom.classList.contains('cm-md-image')) return false;
    this.apply(dom);
    return true;
  }

  private apply(wrap: HTMLElement): void {
    const img = wrap.querySelector('img')!;
    const label = wrap.lastChild as HTMLElement;
    const missing = this.url === '';
    wrap.className = 'cm-md-image' + (this.below ? ' cm-md-image-below' : '') + (missing ? ' cm-md-image-error' : '');
    label.textContent = this.src === '' ? 'No image path yet' : `Image not found: ${this.src}`;
    img.alt = this.alt;
    img.title = this.title || this.alt;
    wrap.dataset.width = this.width;
    if (this.width) img.style.width = cssWidth(this.width);
    else img.style.removeProperty('width');
    if (!missing && img.getAttribute('src') !== this.url) img.src = this.url;
    if (missing) img.removeAttribute('src');
  }

  /** Clicks go to the editor, which puts the cursor next to the image. */
  override ignoreEvent(): boolean {
    return false;
  }
}

/** The number of a footnote: raised where it is referenced, in front of its text where it is defined. */
export class FootnoteWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly reference: boolean,
  ) {
    super();
  }
  override eq(other: FootnoteWidget): boolean {
    return other.label === this.label && other.reference === this.reference;
  }
  override toDOM(): HTMLElement {
    const dom = document.createElement(this.reference ? 'sup' : 'span');
    dom.className = this.reference ? 'cm-md-footnote-ref' : 'cm-md-footnote-label';
    dom.textContent = this.reference ? this.label : `${this.label}.`;
    return dom;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span');
    wrap.className = 'cm-md-checkbox';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.tabIndex = -1;
    box.setAttribute('aria-label', 'Task done');
    wrap.append(box);
    wrap.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      const text = view.state.doc.sliceString(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(text)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: text[1] === ' ' ? 'x' : ' ' },
        userEvent: 'input.format',
      });
    });
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export class RuleWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  override toDOM(): HTMLElement {
    const hr = document.createElement('span');
    hr.className = 'cm-md-hr';
    return hr;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

export class AlertLabelWidget extends WidgetType {
  constructor(readonly kind: string) {
    super();
  }
  override eq(other: AlertLabelWidget): boolean {
    return other.kind === this.kind;
  }
  override toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-md-alert-label';
    span.textContent = this.kind[0].toUpperCase() + this.kind.slice(1).toLowerCase();
    return span;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

function fencedCodeAt(view: EditorView, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'FencedCode') return n;
  }
  return null;
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

/** Replaces the opening fence of a code block: language label and a copy button. */
export class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }

  override eq(other: CodeHeaderWidget): boolean {
    return other.lang === this.lang;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'cm-md-code-header';
    const lang = document.createElement('span');
    lang.className = 'cm-md-code-lang';
    lang.textContent = this.lang || 'text';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'cm-md-code-copy';
    copy.textContent = 'Copy';
    copy.title = 'Copy code';
    copy.tabIndex = -1;
    copy.addEventListener('mousedown', (e) => e.preventDefault());
    copy.addEventListener('click', () => {
      const node = fencedCodeAt(view, view.posAtDOM(dom));
      const body = node?.getChild('CodeText');
      void copyText(body ? view.state.doc.sliceString(body.from, body.to) : '');
      copy.textContent = 'Copied';
      setTimeout(() => (copy.textContent = 'Copy'), 1200);
    });
    dom.append(lang, copy);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** True when the section under the heading on this line is folded away. */
export function isFoldedAt(view: { state: EditorView['state'] }, lineEnd: number): boolean {
  let folded = false;
  foldedRanges(view.state).between(lineEnd, lineEnd, (from) => {
    if (from === lineEnd) folded = true;
  });
  return folded;
}

/** A small arrow in the margin of a heading that folds or unfolds its section. */
export class FoldWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }

  override eq(other: FoldWidget): boolean {
    return other.folded === this.folded;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('span');
    dom.className = 'cm-md-fold' + (this.folded ? ' cm-md-fold-closed' : '');
    dom.textContent = this.folded ? '▸' : '▾';
    dom.title = this.folded ? 'Unfold section' : 'Fold section';
    dom.setAttribute('role', 'button');
    dom.setAttribute('aria-label', dom.title);
    dom.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const line = view.state.doc.lineAt(view.posAtDOM(dom));
      const range = foldable(view.state, line.from, line.to);
      if (!range) return;
      view.dispatch({ effects: (isFoldedAt(view, line.to) ? unfoldEffect : foldEffect).of(range) });
    });
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
