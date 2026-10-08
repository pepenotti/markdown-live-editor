// A rendered GFM table whose cells are edited in place. Every keystroke in a cell is
// written straight back to the Markdown source, so the document never lags behind.
import { type EditorView, WidgetType } from '@codemirror/view';
import { minimalDiff } from '../../shared/textUtil';
import { renderConfig } from '../config';
import { renderInline } from '../inlineRender';
import { bypassGuard, revealBlock } from '../modes';
import { type Align, applyOp, parseTable, serializeTable, setCell, type TableModel, type TableOp } from '../table/model';

interface CellRef {
  r: number;
  c: number;
}

const controllers = new WeakMap<HTMLElement, TableController>();

/** The cell that currently has keyboard focus, in any table. */
let editingCell: HTMLElement | null = null;

export function activeTableCell(): HTMLElement | null {
  return editingCell && editingCell.isConnected && document.activeElement === editingCell ? editingCell : null;
}

/** Wraps the selection inside the focused table cell in a marker such as `**`. */
export function wrapInActiveCell(marker: string): boolean {
  const cell = activeTableCell();
  if (!cell) return false;
  const sel = window.getSelection();
  const text = sel ? sel.toString() : '';
  document.execCommand('insertText', false, marker + text + marker);
  if (sel && text === '') {
    for (let i = 0; i < marker.length; i++) sel.modify('move', 'backward', 'character');
  }
  return true;
}

export class TableWidget extends WidgetType {
  readonly model: TableModel | null;

  constructor(readonly source: string) {
    super();
    this.model = parseTable(source);
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override get estimatedHeight(): number {
    return (this.model ? this.model.rows.length : 2) * 34 + 18;
  }

  override toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement('div');
    dom.className = 'cm-md-table-wrap';
    controllers.set(dom, new TableController(dom, view, this));
    return dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const controller = controllers.get(dom);
    if (!controller || !this.model) return false;
    controller.update(this);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override destroy(dom: HTMLElement): void {
    controllers.get(dom)?.destroy();
  }
}

/** Focuses a cell of the table widget that starts at `pos`. Returns false when it is not drawn. */
export function focusTableAt(view: EditorView, pos: number, where: 'first' | 'last' | 'lastCell', selectAll = false): boolean {
  for (const dom of view.contentDOM.querySelectorAll<HTMLElement>('.cm-md-table-wrap')) {
    const controller = controllers.get(dom);
    if (controller && view.posAtDOM(dom) === pos) {
      controller.focusEdge(where, selectAll);
      return true;
    }
  }
  return false;
}

const TOOLS: { label: string; title: string; run: (t: TableController, at: CellRef) => void; group?: boolean; danger?: boolean }[] = [
  { label: '↑+', title: 'Insert row above', run: (t, at) => t.op({ op: 'insertRow', at: Math.max(1, at.r) }, { r: Math.max(1, at.r), c: at.c }) },
  { label: '↓+', title: 'Insert row below', run: (t, at) => t.op({ op: 'insertRow', at: at.r + 1 }, { r: at.r + 1, c: at.c }) },
  { label: '↑', title: 'Move row up (Alt+Up)', run: (t, at) => t.op({ op: 'moveRow', row: at.r, by: -1 }, { r: at.r - 1, c: at.c }) },
  { label: '↓', title: 'Move row down (Alt+Down)', run: (t, at) => t.op({ op: 'moveRow', row: at.r, by: 1 }, { r: at.r + 1, c: at.c }) },
  { label: 'Delete', danger: true, title: 'Delete this row (Mod+Shift+Backspace). The header row cannot be deleted.', run: (t, at) => t.deleteRow(at) },
  { label: '←+', title: 'Insert column left', group: true, run: (t, at) => t.op({ op: 'insertCol', at: at.c }, at) },
  { label: '→+', title: 'Insert column right', run: (t, at) => t.op({ op: 'insertCol', at: at.c + 1 }, { r: at.r, c: at.c + 1 }) },
  { label: '←', title: 'Move column left', run: (t, at) => t.op({ op: 'moveCol', col: at.c, by: -1 }, { r: at.r, c: at.c - 1 }) },
  { label: '→', title: 'Move column right', run: (t, at) => t.op({ op: 'moveCol', col: at.c, by: 1 }, { r: at.r, c: at.c + 1 }) },
  { label: 'Delete', danger: true, title: 'Delete this column (Mod+Alt+Backspace)', run: (t, at) => t.deleteCol(at) },
  { label: '⇤', title: 'Align column left', group: true, run: (t, at) => t.align(at, 'left') },
  { label: '↔', title: 'Align column centre', run: (t, at) => t.align(at, 'center') },
  { label: '⇥', title: 'Align column right', run: (t, at) => t.align(at, 'right') },
  { label: '</>', title: 'Edit this table as Markdown source', group: true, run: (t) => t.editSource() },
];

const TOOL_GROUPS = ['Row', 'Column', 'Align', ''];
const MOD = /Mac/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

class TableController {
  private widget: TableWidget;
  private active: CellRef | null = null;
  private rebuilding = false;
  private pendingFocus: CellRef | null = null;
  private body!: HTMLTableElement;

  constructor(
    private readonly dom: HTMLElement,
    private readonly view: EditorView,
    widget: TableWidget,
  ) {
    this.widget = widget;
    this.render();
    dom.addEventListener('pointerdown', (e) => this.onPointerDown(e), true);
    dom.addEventListener('focusin', (e) => this.onFocusIn(e));
    dom.addEventListener('focusout', (e) => this.onFocusOut(e));
    dom.addEventListener('input', (e) => this.onInput(e));
    dom.addEventListener('keydown', (e) => this.onKeyDown(e));
    dom.addEventListener('paste', (e) => this.onPaste(e));
  }

  destroy(): void {
    if (editingCell && this.dom.contains(editingCell)) editingCell = null;
  }

  private get model(): TableModel {
    return this.widget.model!;
  }

  private get padCells(): boolean {
    return this.view.state.facet(renderConfig).tableAutoAlign;
  }

  /* ---------- drawing ---------- */

  private render(): void {
    this.rebuilding = true;
    const hadFocus = this.dom.contains(document.activeElement);
    this.dom.textContent = '';

    const tools = document.createElement('div');
    tools.className = 'cm-md-table-tools';
    let group = 0;
    const addLabel = () => {
      if (!TOOL_GROUPS[group]) return;
      const label = document.createElement('span');
      label.className = 'cm-md-table-tools-label';
      label.textContent = TOOL_GROUPS[group];
      tools.append(label);
    };
    addLabel();
    for (const tool of TOOLS) {
      if (tool.group) {
        const sep = document.createElement('span');
        sep.className = 'cm-md-table-tools-sep';
        tools.append(sep);
        group++;
        addLabel();
      }
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = tool.label;
      if (tool.danger) b.className = 'cm-md-table-danger';
      b.title = tool.title.replace(/Mod/g, MOD);
      b.setAttribute('aria-label', tool.title);
      b.tabIndex = -1;
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => tool.run(this, this.active ?? { r: this.model.rows.length - 1, c: 0 }));
      tools.append(b);
    }

    const scroller = document.createElement('div');
    scroller.className = 'cm-md-table-scroll';
    const table = document.createElement('table');
    table.className = 'cm-md-table';
    this.model.rows.forEach((row, r) => {
      const tr = table.insertRow();
      row.forEach((value, c) => {
        const td = document.createElement(r === 0 ? 'th' : 'td');
        const cell = document.createElement('div');
        cell.className = 'cm-md-cell';
        cell.contentEditable = 'plaintext-only';
        if (cell.contentEditable !== 'plaintext-only') cell.contentEditable = 'true';
        cell.spellcheck = this.view.state.facet(renderConfig).spellCheck;
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.setAttribute('role', 'textbox');
        cell.setAttribute('aria-label', `${r === 0 ? 'Header' : `Row ${r}`}, column ${c + 1}`);
        this.setAlign(td, this.model.align[c]);
        this.show(cell, value);
        td.append(cell);
        tr.append(td);
      });
    });
    scroller.append(table);
    this.body = table;
    this.dom.append(tools, scroller);
    this.rebuilding = false;

    const target = this.pendingFocus ?? (hadFocus ? this.active : null);
    this.pendingFocus = null;
    if (target) this.focusCell(target.r, target.c, 'end');
  }

  update(next: TableWidget): void {
    const prev = this.widget.model!;
    this.widget = next;
    const model = next.model!;
    if (model.rows.length !== prev.rows.length || model.align.length !== prev.align.length) {
      this.render();
      return;
    }
    model.rows.forEach((row, r) => {
      row.forEach((value, c) => {
        const cell = this.cell(r, c);
        if (!cell) return;
        this.setAlign(cell.parentElement!, model.align[c]);
        if (cell.dataset.value === value) return;
        if (cell === editingCell) {
          // Changed from outside while being edited, for example by undo.
          cell.dataset.value = value;
          cell.textContent = value;
          placeCaret(cell, 'end');
        } else {
          this.show(cell, value);
        }
      });
    });
    if (this.pendingFocus) {
      const f = this.pendingFocus;
      this.pendingFocus = null;
      this.focusCell(f.r, f.c, 'end');
    }
  }

  private setAlign(td: HTMLElement, align: Align): void {
    if (align) td.style.textAlign = align;
    else td.style.removeProperty('text-align');
  }

  /** Shows a cell as rendered Markdown. */
  private show(cell: HTMLElement, value: string): void {
    cell.dataset.value = value;
    cell.classList.remove('cm-md-cell-editing');
    cell.textContent = '';
    cell.append(renderInline(value, this.view.state.facet(renderConfig)));
  }

  /** Shows a cell as its Markdown text, ready for typing. */
  private edit(cell: HTMLElement): void {
    if (cell.classList.contains('cm-md-cell-editing')) return;
    cell.classList.add('cm-md-cell-editing');
    cell.textContent = cell.dataset.value ?? '';
  }

  private cell(r: number, c: number): HTMLElement | null {
    return this.body.rows[r]?.cells[c]?.firstElementChild as HTMLElement | null;
  }

  private ref(cell: HTMLElement): CellRef {
    return { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
  }

  private cellOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement ? target.closest<HTMLElement>('.cm-md-cell') : null;
  }

  focusCell(r: number, c: number, caret: 'start' | 'end' | 'all'): void {
    const rows = this.model.rows.length;
    const cols = this.model.align.length;
    const cell = this.cell(Math.max(0, Math.min(rows - 1, r)), Math.max(0, Math.min(cols - 1, c)));
    if (!cell) return;
    this.edit(cell);
    cell.focus({ preventScroll: true });
    placeCaret(cell, caret);
    cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  focusEdge(where: 'first' | 'last' | 'lastCell', selectAll = false): void {
    const lastRow = this.model.rows.length - 1;
    if (where === 'first') this.focusCell(0, 0, selectAll ? 'all' : 'end');
    else this.focusCell(lastRow, where === 'lastCell' ? this.model.align.length - 1 : 0, 'end');
  }

  /* ---------- events ---------- */

  private onPointerDown(e: PointerEvent): void {
    const cell = this.cellOf(e.target);
    if (cell) {
      // Switch to the Markdown text before the browser places the caret.
      this.edit(cell);
      return;
    }
    // A click on the padding of a table cell edits that cell.
    const td = e.target instanceof HTMLElement ? e.target.closest('td,th') : null;
    const inner = td?.firstElementChild as HTMLElement | null;
    if (inner && this.dom.contains(inner)) {
      e.preventDefault();
      const ref = this.ref(inner);
      this.focusCell(ref.r, ref.c, 'end');
    }
  }

  private onFocusIn(e: FocusEvent): void {
    const cell = this.cellOf(e.target);
    if (!cell) return;
    this.edit(cell);
    editingCell = cell;
    this.active = this.ref(cell);
    this.dom.classList.add('cm-md-table-active');
  }

  private onFocusOut(e: FocusEvent): void {
    if (this.rebuilding) return;
    const cell = this.cellOf(e.target);
    if (!cell || !cell.isConnected) return;
    if (editingCell === cell) editingCell = null;
    this.show(cell, cell.dataset.value ?? '');
    if (!this.dom.contains(e.relatedTarget as Node | null)) this.dom.classList.remove('cm-md-table-active');
  }

  private onInput(e: Event): void {
    const cell = this.cellOf(e.target);
    if (!cell) return;
    const ref = this.ref(cell);
    const text = readCell(cell);
    if (text === cell.dataset.value) return;
    const next = setCell(this.widget.source, ref.r, ref.c, text, this.padCells);
    if (next === null) return;
    cell.dataset.value = text;
    this.replaceSource(next, 'input.type');
  }

  private onKeyDown(e: KeyboardEvent): void {
    const cell = this.cellOf(e.target);
    if (!cell || e.isComposing) return;
    const { r, c } = this.ref(cell);
    const rows = this.model.rows.length;
    const cols = this.model.align.length;
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };

    if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && (e.shiftKey || e.altKey)) {
      handled();
      if (e.altKey) this.deleteCol({ r, c });
      else this.deleteRow({ r, c });
    } else if (e.key === 'Tab' && plain) {
      handled();
      if (e.shiftKey) {
        if (c > 0) this.focusCell(r, c - 1, 'end');
        else if (r > 0) this.focusCell(r - 1, cols - 1, 'end');
      } else if (c < cols - 1) this.focusCell(r, c + 1, 'end');
      else if (r < rows - 1) this.focusCell(r + 1, 0, 'end');
      else this.op({ op: 'insertRow', at: rows }, { r: rows, c: 0 });
    } else if (e.key === 'Enter' && plain) {
      handled();
      if (r < rows - 1) this.focusCell(r + 1, c, 'end');
      else this.op({ op: 'insertRow', at: rows }, { r: rows, c });
    } else if (e.key === 'Escape') {
      handled();
      this.leave(true);
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.altKey && !e.metaKey && !e.ctrlKey) {
      handled();
      const by = e.key === 'ArrowUp' ? -1 : 1;
      this.op({ op: 'moveRow', row: r, by }, { r: r + by, c });
    } else if (e.key === 'ArrowUp' && plain && !e.shiftKey) {
      handled();
      if (r > 0) this.focusCell(r - 1, c, 'end');
      else this.leave(false);
    } else if (e.key === 'ArrowDown' && plain && !e.shiftKey) {
      handled();
      if (r < rows - 1) this.focusCell(r + 1, c, 'end');
      else this.leave(true);
    } else if (e.key === 'ArrowLeft' && plain && !e.shiftKey && caretAt(cell, 'start')) {
      if (c > 0 || r > 0) {
        handled();
        if (c > 0) this.focusCell(r, c - 1, 'end');
        else this.focusCell(r - 1, cols - 1, 'end');
      }
    } else if (e.key === 'ArrowRight' && plain && !e.shiftKey && caretAt(cell, 'end')) {
      if (c < cols - 1 || r < rows - 1) {
        handled();
        if (c < cols - 1) this.focusCell(r, c + 1, 'start');
        else this.focusCell(r + 1, 0, 'start');
      }
    }
  }

  /** Pasting several cells fills the grid from the focused cell onwards. */
  private onPaste(e: ClipboardEvent): void {
    const cell = this.cellOf(e.target);
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!cell) return;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
    if (lines.length < 2 && !text.includes('\t')) {
      // A single value: keep it on one line and let the browser insert it.
      if (/[\r\n]/.test(text)) {
        e.preventDefault();
        document.execCommand('insertText', false, text.replace(/\s*[\r\n]+\s*/g, ' ').trim());
      }
      return;
    }
    e.preventDefault();
    const { r, c } = this.ref(cell);
    const model = parseTable(this.widget.source);
    if (!model) return;
    const grid = lines.map((l) => l.split('\t').map((v) => v.trim()));
    const width = Math.max(...grid.map((row) => row.length));
    while (model.align.length < c + width) applyOp(model, { op: 'insertCol', at: model.align.length });
    while (model.rows.length < r + grid.length) applyOp(model, { op: 'insertRow', at: model.rows.length });
    grid.forEach((row, i) => row.forEach((value, j) => (model.rows[r + i][c + j] = value)));
    this.pendingFocus = { r: r + grid.length - 1, c: c + width - 1 };
    this.replaceSource(serializeTable(model, this.padCells), 'input.paste');
  }

  /* ---------- writing back ---------- */

  private pos(): number | null {
    const from = this.view.posAtDOM(this.dom);
    const source = this.widget.source;
    return this.view.state.doc.sliceString(from, from + source.length) === source ? from : null;
  }

  private replaceSource(next: string, userEvent: string): void {
    const from = this.pos();
    const source = this.widget.source;
    const diff = minimalDiff(source, next);
    if (from === null || !diff) {
      this.pendingFocus = null;
      return;
    }
    this.view.dispatch({
      changes: { from: from + diff.from, to: from + diff.toA, insert: next.slice(diff.from, diff.toB) },
      annotations: bypassGuard.of(true),
      userEvent,
    });
  }

  op(op: TableOp, focus?: CellRef): void {
    const model = parseTable(this.widget.source);
    if (!model || !applyOp(model, op)) return;
    this.pendingFocus = focus ?? null;
    this.replaceSource(serializeTable(model, this.padCells), 'input.table');
  }

  deleteRow(at: CellRef): void {
    this.op({ op: 'deleteRow', row: at.r }, { r: Math.min(at.r, this.model.rows.length - 2), c: at.c });
  }

  deleteCol(at: CellRef): void {
    this.op({ op: 'deleteCol', col: at.c }, { r: at.r, c: Math.min(at.c, this.model.align.length - 2) });
  }

  align(at: CellRef, align: Align): void {
    const current = this.model.align[at.c];
    this.op({ op: 'align', col: at.c, align: current === align ? null : align }, at);
  }

  /** Shows the Markdown source of this table until the cursor leaves it. */
  editSource(): void {
    const from = this.pos();
    if (from === null) return;
    this.view.dispatch({ effects: revealBlock.of(from), selection: { anchor: from } });
    this.view.focus();
  }

  /** Moves the cursor out of the table onto the line before or after it, adding one if needed. */
  private leave(after: boolean): void {
    const from = this.pos();
    if (from === null) return;
    const doc = this.view.state.doc;
    const end = from + this.widget.source.length;
    this.view.focus();
    if (after && end === doc.length) {
      this.view.dispatch({ changes: { from: end, insert: '\n' }, selection: { anchor: end + 1 }, annotations: bypassGuard.of(true), scrollIntoView: true, userEvent: 'input.table' });
    } else if (!after && from === 0) {
      this.view.dispatch({ changes: { from: 0, insert: '\n\n' }, selection: { anchor: 0 }, annotations: bypassGuard.of(true), scrollIntoView: true, userEvent: 'input.table' });
    } else {
      this.view.dispatch({ selection: { anchor: after ? end + 1 : from - 1 }, scrollIntoView: true });
    }
  }
}

function readCell(cell: HTMLElement): string {
  return (cell.textContent ?? '').replace(/ /g, ' ').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function placeCaret(cell: HTMLElement, where: 'start' | 'end' | 'all'): void {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (where !== 'all') range.collapse(where === 'start');
  sel.removeAllRanges();
  sel.addRange(range);
}

function caretAt(cell: HTMLElement, where: 'start' | 'end'): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed || !sel.anchorNode || !cell.contains(sel.anchorNode)) return false;
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (where === 'start') range.setEnd(sel.anchorNode, sel.anchorOffset);
  else range.setStart(sel.anchorNode, sel.anchorOffset);
  return range.toString() === '';
}
