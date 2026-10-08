// @vitest-environment jsdom
// The rendered table grid in a real editor: tool bar, menu, keyboard and what reaches the document.
import { EditorState, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { renderConfig } from '../../src/webview/config';

const TABLE = ['| Name   | Qty |', '| :----- | --: |', '| Pear   |  10 |', '| apple  |   9 |', '| Banana |     |'].join('\n');

let TableWidget: typeof import('../../src/webview/widgets/table').TableWidget;
let view: EditorView | null = null;
/** How many transactions changed the document: one per undo step for the host. */
let edits = 0;

beforeAll(async () => {
  // Layout calls that jsdom does not have.
  const rects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const rect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }) as DOMRect;
  Range.prototype.getClientRects = rects;
  Range.prototype.getBoundingClientRect = rect;
  Element.prototype.scrollIntoView = () => {};
  // jsdom does not focus an editable element unless it has a tab index.
  const focus = HTMLElement.prototype.focus;
  HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
    if (this.classList.contains('cm-md-cell') && !this.hasAttribute('tabindex')) this.tabIndex = -1;
    focus.call(this, options);
  };
  (globalThis as { PointerEvent?: unknown }).PointerEvent ??= MouseEvent;
  ({ TableWidget } = await import('../../src/webview/widgets/table'));
});

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = '';
});

function open(doc = TABLE, spellCheck = false): EditorView {
  const build = (state: EditorState): DecorationSet => Decoration.set([Decoration.replace({ widget: new TableWidget(state.doc.toString()), block: true }).range(0, state.doc.length)]);
  const field = StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f),
  });
  edits = 0;
  const counter = EditorView.updateListener.of((u) => {
    if (u.docChanged) edits += u.transactions.filter((t) => t.docChanged).length;
  });
  view = new EditorView({ state: EditorState.create({ doc, extensions: [field, counter, renderConfig.of({ resolveUrl: (s) => s, monoRatio: 0.6, tableAutoAlign: true, spellCheck })] }), parent: document.body });
  return view;
}

const cell = (r: number, c: number) => document.querySelector<HTMLElement>(`.cm-md-cell[data-r="${r}"][data-c="${c}"]`)!;
const names = () => [...document.querySelectorAll<HTMLElement>('.cm-md-cell[data-c="0"]')].map((c) => c.dataset.value);
const focused = () => {
  const a = document.activeElement as HTMLElement | null;
  return a?.classList.contains('cm-md-cell') ? `${a.dataset.r},${a.dataset.c}` : null;
};
const tool = (id: string) => document.querySelector<HTMLElement>(`.cm-md-table-tools button[data-action="${id}"]`)!;
const menu = () => document.querySelector<HTMLElement>('.cm-md-table-menu');
const item = (id: string) => document.querySelector<HTMLElement>(`.cm-md-table-menu button[data-action="${id}"]`)!;
const key = (target: HTMLElement, k: string, mods: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mods });
  target.dispatchEvent(e);
  return e;
};
const rightClick = (target: HTMLElement, between?: () => void) => {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 2 }));
  between?.();
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
  target.dispatchEvent(e);
  return e;
};
const selectAll = (target: HTMLElement) => {
  const range = document.createRange();
  range.selectNodeContents(target);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
};

describe('table widget', () => {
  it('sorts from the tool bar as one change and keeps the focus on the row', () => {
    const v = open();
    cell(1, 1).focus();
    tool('sortAsc').click();
    expect(names()).toEqual(['Name', 'apple', 'Pear', 'Banana']);
    expect(v.state.doc.toString().split('\n').slice(0, 2)).toEqual(TABLE.split('\n').slice(0, 2));
    expect(edits).toBe(1);
    expect(focused()).toBe('2,1');
    tool('sortDesc').click();
    expect(names()).toEqual(['Name', 'Pear', 'apple', 'Banana']);
    expect(edits).toBe(2);
    expect(focused()).toBe('1,1');
  });

  it('duplicates the row with Mod+Shift+D', () => {
    open();
    cell(2, 0).focus();
    const e = key(cell(2, 0), 'D', { ctrlKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(names()).toEqual(['Name', 'Pear', 'apple', 'apple', 'Banana']);
    expect(edits).toBe(1);
    expect(focused()).toBe('3,0');
  });

  it('never deletes, duplicates or moves the header row', () => {
    const v = open();
    cell(0, 0).focus();
    key(cell(0, 0), 'd', { metaKey: true, shiftKey: true });
    key(cell(0, 0), 'Backspace', { metaKey: true, shiftKey: true });
    for (const id of ['rowDelete', 'rowDuplicate', 'rowUp', 'rowDown']) {
      expect(tool(id).getAttribute('aria-disabled')).toBe('true');
      tool(id).click();
    }
    rightClick(cell(0, 0));
    for (const id of ['rowDelete', 'rowDuplicate', 'rowUp', 'rowDown']) {
      expect(item(id).getAttribute('aria-disabled')).toBe('true');
      item(id).click();
    }
    expect(v.state.doc.toString()).toBe(TABLE);
    expect(edits).toBe(0);
    // Sorting from the header cell sorts the body and leaves the header first.
    item('sortAsc').click();
    expect(names()).toEqual(['Name', 'apple', 'Banana', 'Pear']);
    expect(focused()).toBe('0,0');
  });

  it('opens the menu on right-click and runs the same actions', () => {
    const v = open();
    const e = rightClick(cell(2, 0));
    expect(e.defaultPrevented).toBe(true);
    expect(focused()).toBe('2,0');
    expect([...menu()!.querySelectorAll('button')].map((b) => b.dataset.action)).toEqual([
      ...['rowAbove', 'rowBelow', 'rowUp', 'rowDown', 'rowDuplicate', 'rowClear', 'rowDelete'],
      ...['colLeft', 'colRight', 'colMoveLeft', 'colMoveRight', 'colClear', 'colDelete'],
      ...['sortAsc', 'sortDesc', 'alignLeft', 'alignCenter', 'alignRight', 'copyMarkdown', 'copyTSV', 'source'],
    ]);
    expect(item('alignLeft').getAttribute('aria-checked')).toBe('true');
    item('rowClear').click();
    expect(menu()).toBeNull();
    expect(v.state.doc.toString().split('\n')[3]).toBe('|        |     |');
    expect(edits).toBe(1);
    expect(focused()).toBe('2,0');

    rightClick(cell(1, 1));
    item('colClear').click();
    expect(v.state.doc.toString()).toBe(['| Name   | Qty |', '| :----- | --: |', '| Pear   |     |', '|        |     |', '| Banana |     |'].join('\n'));
    expect(edits).toBe(2);
    expect(focused()).toBe('1,1');
  });

  it('drives the menu from the keyboard without leaving the cell', () => {
    open();
    rightClick(cell(1, 0));
    key(cell(1, 0), 'ArrowDown'); // Insert row: Above
    key(cell(1, 0), 'ArrowRight'); // Below
    expect(document.querySelector('.cm-md-table-menu-current')).toBe(item('rowBelow'));
    expect(focused()).toBe('1,0');
    key(cell(1, 0), 'Enter');
    expect(menu()).toBeNull();
    expect(names()).toEqual(['Name', 'Pear', '', 'apple', 'Banana']);
    expect(edits).toBe(1);
    expect(focused()).toBe('2,0');

    rightClick(cell(1, 0));
    const esc = key(cell(1, 0), 'Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(menu()).toBeNull();
    // Escape closed the menu only: the focus is still in the table.
    expect(focused()).toBe('1,0');
  });

  it('toggles the menu from the "…" button and closes it when the table changes', () => {
    const v = open();
    cell(1, 0).focus();
    const more = document.querySelector<HTMLElement>('.cm-md-table-more')!;
    more.click();
    expect(menu()).not.toBeNull();
    more.click();
    expect(menu()).toBeNull();
    more.click();
    v.dispatch({ changes: { from: 2, to: 6, insert: 'Item' } });
    expect(menu()).toBeNull();
    more.click();
    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it('keeps the usual menu when text was selected before the right-click', () => {
    open();
    cell(1, 0).focus();
    selectAll(cell(1, 0));
    const e = rightClick(cell(1, 0));
    expect(e.defaultPrevented).toBe(false);
    expect(menu()).toBeNull();
  });

  it('shows the table menu when the right-click itself selected the word, as on a Mac', () => {
    open();
    cell(1, 0).focus();
    window.getSelection()!.collapse(cell(1, 0), 0);
    const e = rightClick(cell(1, 0), () => selectAll(cell(1, 0)));
    expect(e.defaultPrevented).toBe(true);
    expect(menu()).not.toBeNull();
    // The word the click selected is released, so typing next does not replace it.
    expect(window.getSelection()!.isCollapsed).toBe(true);
    expect(focused()).toBe('1,0');
  });

  it('keeps the spell-check setting on every cell after the grid is rebuilt', () => {
    for (const on of [true, false]) {
      open(TABLE, on);
      cell(1, 0).focus();
      tool('rowDuplicate').click();
      tool('colRight').click();
      const cells = [...document.querySelectorAll<HTMLElement>('.cm-md-cell')];
      expect(cells).toHaveLength(15);
      // jsdom keeps `spellcheck` as a plain property; a browser reflects it as the attribute.
      expect(cells.map((c) => (c as unknown as { spellcheck: boolean }).spellcheck)).toEqual(new Array(15).fill(on));
      view!.destroy();
      document.body.textContent = '';
    }
  });
});
