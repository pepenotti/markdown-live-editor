// A rendered GFM table whose cells are edited in place. Every keystroke in a cell is
// written straight back to the Markdown source, so the document never lags behind.
import { type EditorView, WidgetType } from '@codemirror/view';
import { minimalDiff } from '../../shared/textUtil';
import { renderConfig } from '../config';
import { renderInline } from '../inlineRender';
import { bypassGuard, revealBlock } from '../modes';
import { type Align, applyOp, parseTable, serializeTable, setCell, type TableModel, type TableOp, tableToTSV } from '../table/model';
import { copyText } from './simple';

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

/** One thing that can be done to the table from the focused cell. The tool bar, the menu and the keyboard all run these. */
interface Action {
  title: string;
  run: (t: TableController, at: CellRef) => void;
  /** Absent means always possible. */
  enabled?: (t: TableController, at: CellRef) => boolean;
  danger?: boolean;
  /** For actions that set a state, such as alignment: whether that state is the current one. */
  on?: (t: TableController, at: CellRef) => boolean;
}

const ACTIONS = {
  rowAbove: { title: 'Insert row above', run: (t, at) => t.op({ op: 'insertRow', at: Math.max(1, at.r) }, { r: Math.max(1, at.r), c: at.c }) },
  rowBelow: { title: 'Insert row below', run: (t, at) => t.op({ op: 'insertRow', at: at.r + 1 }, { r: at.r + 1, c: at.c }) },
  rowUp: { title: 'Move row up (Alt+Up)', enabled: (_t, at) => at.r > 1, run: (t, at) => t.op({ op: 'moveRow', row: at.r, by: -1 }, { r: at.r - 1, c: at.c }) },
  rowDown: {
    title: 'Move row down (Alt+Down)',
    enabled: (t, at) => at.r >= 1 && at.r < t.rowCount - 1,
    run: (t, at) => t.op({ op: 'moveRow', row: at.r, by: 1 }, { r: at.r + 1, c: at.c }),
  },
  rowDuplicate: {
    title: 'Duplicate this row (Mod+Shift+D). The header row cannot be duplicated.',
    enabled: (_t, at) => at.r >= 1,
    run: (t, at) => t.op({ op: 'duplicateRow', row: at.r }, { r: at.r + 1, c: at.c }),
  },
  rowClear: { title: 'Empty every cell of this row', run: (t, at) => t.op({ op: 'clearRow', row: at.r }, at) },
  rowDelete: {
    title: 'Delete this row (Mod+Shift+Backspace). The header row cannot be deleted.',
    danger: true,
    enabled: (_t, at) => at.r >= 1,
    run: (t, at) => t.deleteRow(at),
  },
  colLeft: { title: 'Insert column left', run: (t, at) => t.op({ op: 'insertCol', at: at.c }, at) },
  colRight: { title: 'Insert column right', run: (t, at) => t.op({ op: 'insertCol', at: at.c + 1 }, { r: at.r, c: at.c + 1 }) },
  colMoveLeft: { title: 'Move column left', enabled: (_t, at) => at.c > 0, run: (t, at) => t.op({ op: 'moveCol', col: at.c, by: -1 }, { r: at.r, c: at.c - 1 }) },
  colMoveRight: {
    title: 'Move column right',
    enabled: (t, at) => at.c < t.colCount - 1,
    run: (t, at) => t.op({ op: 'moveCol', col: at.c, by: 1 }, { r: at.r, c: at.c + 1 }),
  },
  colClear: { title: 'Empty every cell of this column below the header', run: (t, at) => t.op({ op: 'clearCol', col: at.c }, at) },
  colDelete: { title: 'Delete this column (Mod+Alt+Backspace)', danger: true, enabled: (t) => t.colCount > 1, run: (t, at) => t.deleteCol(at) },
  sortAsc: { title: 'Sort rows by this column, ascending', enabled: (t) => t.rowCount > 2, run: (t, at) => t.sort(at, 'asc') },
  sortDesc: { title: 'Sort rows by this column, descending', enabled: (t) => t.rowCount > 2, run: (t, at) => t.sort(at, 'desc') },
  alignLeft: { title: 'Align column left', on: (t, at) => t.alignOf(at) === 'left', run: (t, at) => t.align(at, 'left') },
  alignCenter: { title: 'Align column centre', on: (t, at) => t.alignOf(at) === 'center', run: (t, at) => t.align(at, 'center') },
  alignRight: { title: 'Align column right', on: (t, at) => t.alignOf(at) === 'right', run: (t, at) => t.align(at, 'right') },
  copyMarkdown: { title: 'Copy this table as Markdown', run: (t, at) => t.copy(at, 'markdown') },
  copyTSV: { title: 'Copy this table as tab-separated text, for a spreadsheet', run: (t, at) => t.copy(at, 'tsv') },
  source: { title: 'Edit this table as Markdown source', run: (t) => t.editSource() },
} satisfies Record<string, Action>;

type ActionId = keyof typeof ACTIONS;

/**
 * The bar above the table. `keep` says how long a button stays when the editor gets
 * narrow: 0 goes first, 2 goes last. Everything is always in the "…" menu.
 */
const TOOL_GROUPS: { name: string; tools: { id: ActionId; label: string; keep: 0 | 1 | 2 }[] }[] = [
  {
    name: 'Row',
    tools: [
      { id: 'rowAbove', label: '↑+', keep: 1 },
      { id: 'rowBelow', label: '↓+', keep: 2 },
      { id: 'rowUp', label: '↑', keep: 1 },
      { id: 'rowDown', label: '↓', keep: 1 },
      { id: 'rowDuplicate', label: '⧉', keep: 0 },
      { id: 'rowDelete', label: 'Delete', keep: 2 },
    ],
  },
  {
    name: 'Column',
    tools: [
      { id: 'colLeft', label: '←+', keep: 1 },
      { id: 'colRight', label: '→+', keep: 2 },
      { id: 'colMoveLeft', label: '←', keep: 0 },
      { id: 'colMoveRight', label: '→', keep: 0 },
      { id: 'colDelete', label: 'Delete', keep: 2 },
    ],
  },
  {
    name: 'Sort',
    tools: [
      { id: 'sortAsc', label: 'A→Z', keep: 1 },
      { id: 'sortDesc', label: 'Z→A', keep: 1 },
    ],
  },
  {
    name: 'Align',
    tools: [
      { id: 'alignLeft', label: '⇤', keep: 0 },
      { id: 'alignCenter', label: '↔', keep: 0 },
      { id: 'alignRight', label: '⇥', keep: 0 },
    ],
  },
  { name: '', tools: [{ id: 'source', label: '</>', keep: 1 }] },
];

/** The menu shown by a right-click in a cell and by the "…" button. `null` is a divider. */
const MENU: ({ label?: string; items: { id: ActionId; label: string; hint?: string }[] } | null)[] = [
  { label: 'Insert row', items: [{ id: 'rowAbove', label: 'Above' }, { id: 'rowBelow', label: 'Below' }] },
  { label: 'Move row', items: [{ id: 'rowUp', label: 'Up' }, { id: 'rowDown', label: 'Down' }] },
  { items: [{ id: 'rowDuplicate', label: 'Duplicate row', hint: 'Mod+Shift+D' }] },
  { items: [{ id: 'rowClear', label: 'Clear row' }] },
  { items: [{ id: 'rowDelete', label: 'Delete row', hint: 'Mod+Shift+Backspace' }] },
  null,
  { label: 'Insert column', items: [{ id: 'colLeft', label: 'Left' }, { id: 'colRight', label: 'Right' }] },
  { label: 'Move column', items: [{ id: 'colMoveLeft', label: 'Left' }, { id: 'colMoveRight', label: 'Right' }] },
  { items: [{ id: 'colClear', label: 'Clear column' }] },
  { items: [{ id: 'colDelete', label: 'Delete column', hint: 'Mod+Alt+Backspace' }] },
  null,
  { label: 'Sort by column', items: [{ id: 'sortAsc', label: 'A → Z' }, { id: 'sortDesc', label: 'Z → A' }] },
  { label: 'Align column', items: [{ id: 'alignLeft', label: 'Left' }, { id: 'alignCenter', label: 'Centre' }, { id: 'alignRight', label: 'Right' }] },
  null,
  { label: 'Copy table as', items: [{ id: 'copyMarkdown', label: 'Markdown' }, { id: 'copyTSV', label: 'TSV' }] },
  { items: [{ id: 'source', label: 'Edit as Markdown source' }] },
];

const IS_MAC = /Mac/.test(navigator.platform);
const MOD = IS_MAC ? 'Cmd' : 'Ctrl';
/** Writes a shortcut the way the platform does: `Mod+Shift+D` is `⇧⌘D` on a Mac and `Ctrl+Shift+D` elsewhere. */
function shortcut(keys: string): string {
  if (!IS_MAC) return keys.replace(/Mod/g, 'Ctrl');
  const glyph: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Backspace: '⌫' };
  const parts = keys.split('+');
  const key = parts.pop()!;
  const order = ['Alt', 'Shift', 'Mod'];
  return [...parts].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((k) => glyph[k] ?? k).join('') + (glyph[key] ?? key);
}

/** The open table menu, if any. There is at most one in the whole editor. */
let openMenu: { el: HTMLElement; owner: TableController; anchor: HTMLElement | null; rows: HTMLElement[][]; at: [number, number] | null; close: () => void } | null = null;

function closeMenu(): void {
  openMenu?.close();
}

class TableController {
  private widget: TableWidget;
  private active: CellRef | null = null;
  private rebuilding = false;
  private pendingFocus: CellRef | null = null;
  private body!: HTMLTableElement;
  private tools!: HTMLElement;
  private readonly resize: ResizeObserver | null;

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
    dom.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => this.fitTools());
    this.resize?.observe(dom);
  }

  destroy(): void {
    if (editingCell && this.dom.contains(editingCell)) editingCell = null;
    if (openMenu?.owner === this) closeMenu();
    this.resize?.disconnect();
  }

  private get model(): TableModel {
    return this.widget.model!;
  }

  get rowCount(): number {
    return this.model.rows.length;
  }

  get colCount(): number {
    return this.model.align.length;
  }

  alignOf(at: CellRef): Align {
    return this.model.align[at.c] ?? null;
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
    tools.setAttribute('role', 'toolbar');
    tools.setAttribute('aria-label', 'Table');
    const button = (label: string, title: string, run: (b: HTMLButtonElement) => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title.replace(/Mod/g, MOD);
      b.setAttribute('aria-label', title.replace(/Mod/g, MOD));
      b.tabIndex = -1;
      // Keep the focus in the cell.
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => run(b));
      return b;
    };
    for (const group of TOOL_GROUPS) {
      const span = document.createElement('span');
      span.className = 'cm-md-table-tools-group';
      if (group.name) {
        const label = document.createElement('span');
        label.className = 'cm-md-table-tools-label';
        label.textContent = group.name;
        span.append(label);
      }
      for (const tool of group.tools) {
        const action: Action = ACTIONS[tool.id];
        const b = button(tool.label, action.title, () => this.run(tool.id, this.current()));
        if (action.danger) b.className = 'cm-md-table-danger';
        b.dataset.action = tool.id;
        b.dataset.keep = String(tool.keep);
        span.append(b);
      }
      tools.append(span);
    }
    const more = document.createElement('span');
    more.className = 'cm-md-table-tools-group';
    const moreButton = button('…', 'More table actions (also on right-click)', (b) => {
      if (openMenu?.owner === this && openMenu.anchor === b) closeMenu();
      else this.showMenu(this.current(), b);
    });
    moreButton.classList.add('cm-md-table-more');
    moreButton.setAttribute('aria-haspopup', 'menu');
    more.append(moreButton);
    tools.append(more);
    this.tools = tools;

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
    this.fitTools();
  }

  /** The cell the tool bar acts on. */
  private current(): CellRef {
    return this.active ?? { r: this.model.rows.length - 1, c: 0 };
  }

  private can(id: ActionId, at: CellRef): boolean {
    const action: Action = ACTIONS[id];
    return !action.enabled || action.enabled(this, at);
  }

  private run(id: ActionId, at: CellRef): void {
    if (this.can(id, at)) ACTIONS[id].run(this, at);
  }

  /**
   * Hides the less used buttons, a step at a time, until the bar fits the editor's width.
   * The hidden actions stay reachable through the "…" button.
   */
  private fitTools(): void {
    if (!this.dom.classList.contains('cm-md-table-active')) return;
    const style = getComputedStyle(this.dom);
    const room = this.dom.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const groups = [...this.tools.children] as HTMLElement[];
    for (let level = 0; level <= 3; level++) {
      for (const group of groups) {
        let shown = 0;
        for (const b of group.querySelectorAll<HTMLElement>('button')) {
          b.hidden = b.dataset.keep !== undefined && Number(b.dataset.keep) < level;
          if (!b.hidden) shown++;
        }
        group.hidden = shown === 0;
      }
      if (this.tools.offsetWidth <= room) break;
    }
    this.markTools();
  }

  /** Greys out the buttons that do nothing for the focused cell and marks the column's alignment. */
  private markTools(): void {
    const at = this.current();
    for (const b of this.tools.querySelectorAll<HTMLElement>('button[data-action]')) {
      const id = b.dataset.action as ActionId;
      const action: Action = ACTIONS[id];
      b.setAttribute('aria-disabled', String(!this.can(id, at)));
      if (action.on) b.setAttribute('aria-pressed', String(action.on(this, at)));
    }
  }

  /* ---------- menu ---------- */

  /** Opens the table menu for a cell, under `anchor` or at a point of the window. */
  private showMenu(at: CellRef, anchor: HTMLElement | { x: number; y: number }): void {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'cm-md-table-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Table');
    const rows: HTMLElement[][] = [];
    for (const entry of MENU) {
      if (!entry) {
        const sep = document.createElement('div');
        sep.className = 'cm-md-table-menu-sep';
        el.append(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'cm-md-table-menu-row';
      if (entry.label) {
        const label = document.createElement('span');
        label.className = 'cm-md-table-menu-label';
        label.textContent = entry.label;
        row.append(label);
      }
      const usable: HTMLElement[] = [];
      for (const item of entry.items) {
        const action: Action = ACTIONS[item.id];
        const b = document.createElement('button');
        b.type = 'button';
        b.tabIndex = -1;
        b.setAttribute('role', 'menuitem');
        b.dataset.action = item.id;
        b.title = action.title.replace(/Mod/g, MOD);
        const text = document.createElement('span');
        text.textContent = item.label;
        b.append(text);
        if (item.hint) {
          const hint = document.createElement('span');
          hint.className = 'cm-md-table-menu-hint';
          hint.textContent = shortcut(item.hint);
          b.append(hint);
        }
        if (!entry.label) b.classList.add('cm-md-table-menu-wide');
        if (action.danger) b.classList.add('cm-md-table-danger');
        if (action.on?.(this, at)) b.setAttribute('aria-checked', 'true');
        const enabled = this.can(item.id, at);
        b.setAttribute('aria-disabled', String(!enabled));
        if (enabled) usable.push(b);
        b.addEventListener('click', () => {
          if (!enabled) return;
          closeMenu();
          this.run(item.id, at);
        });
        row.append(b);
      }
      if (usable.length) rows.push(usable);
      el.append(row);
    }
    // Clicks in the menu must not take the focus out of the cell, and the menu has no menu of its own.
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    const button = anchor instanceof HTMLElement ? anchor : null;
    const outside = (e: Event) => {
      const target = e.target as Node | null;
      if (el.contains(target)) return;
      // The "…" button closes its own menu when it is clicked again.
      if (button && button.contains(target)) return;
      closeMenu();
    };
    const dismiss = () => closeMenu();
    const scroller = this.view.scrollDOM;
    document.addEventListener('pointerdown', outside, true);
    scroller.addEventListener('scroll', dismiss, { passive: true });
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    button?.setAttribute('aria-expanded', 'true');
    openMenu = {
      el,
      owner: this,
      anchor: button,
      rows,
      at: null,
      close: () => {
        document.removeEventListener('pointerdown', outside, true);
        scroller.removeEventListener('scroll', dismiss);
        window.removeEventListener('resize', dismiss);
        window.removeEventListener('blur', dismiss);
        button?.removeAttribute('aria-expanded');
        el.remove();
        openMenu = null;
      },
    };

    this.view.dom.append(el);
    // Keep the whole menu inside the window.
    const margin = 6;
    const box = button?.getBoundingClientRect();
    let x = box ? box.right - el.offsetWidth : (anchor as { x: number }).x;
    let y = box ? box.bottom + 2 : (anchor as { y: number }).y;
    x = Math.max(margin, Math.min(x, window.innerWidth - el.offsetWidth - margin));
    if (y + el.offsetHeight + margin > window.innerHeight) y = Math.max(margin, window.innerHeight - el.offsetHeight - margin);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  /** Moves the highlighted menu entry: `dr` between lines, `dc` along a line. */
  private stepMenu(dr: number, dc: number): void {
    const menu = openMenu;
    if (!menu || !menu.rows.length) return;
    let r: number;
    let c: number;
    if (!menu.at) {
      r = dr < 0 ? menu.rows.length - 1 : 0;
      c = 0;
    } else {
      r = (menu.at[0] + dr + menu.rows.length) % menu.rows.length;
      const line = menu.rows[r];
      c = dr ? Math.min(menu.at[1], line.length - 1) : (menu.at[1] + dc + line.length) % line.length;
    }
    menu.el.querySelector('.cm-md-table-menu-current')?.classList.remove('cm-md-table-menu-current');
    menu.at = [r, c];
    menu.rows[r][c].classList.add('cm-md-table-menu-current');
    menu.rows[r][c].scrollIntoView({ block: 'nearest' });
  }

  private onContextMenu(e: MouseEvent): void {
    const hit = e.target instanceof HTMLElement ? e.target : null;
    const cell = this.cellOf(hit) ?? (hit?.closest('td,th')?.firstElementChild as HTMLElement | null | undefined) ?? null;
    if (!cell || !this.body.contains(cell)) return;
    // With text selected in the cell, leave the usual menu (cut, copy, paste) alone.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && cell.contains(sel.anchorNode) && document.activeElement === cell) return;
    e.preventDefault();
    e.stopPropagation();
    const at = this.ref(cell);
    if (document.activeElement !== cell) this.focusCell(at.r, at.c, 'end');
    // The keyboard's menu key reports no useful point: open under the cell instead.
    const box = cell.getBoundingClientRect();
    const inside = e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    this.showMenu(at, inside ? { x: e.clientX, y: e.clientY } : { x: box.left, y: box.bottom });
  }

  update(next: TableWidget): void {
    if (openMenu?.owner === this) closeMenu();
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
    this.markTools();
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
    const shown = this.dom.classList.contains('cm-md-table-active');
    this.dom.classList.add('cm-md-table-active');
    if (shown) this.markTools();
    else this.fitTools();
  }

  private onFocusOut(e: FocusEvent): void {
    if (this.rebuilding) return;
    const cell = this.cellOf(e.target);
    if (!cell || !cell.isConnected) return;
    if (editingCell === cell) editingCell = null;
    this.show(cell, cell.dataset.value ?? '');
    if (!this.dom.contains(e.relatedTarget as Node | null)) {
      this.dom.classList.remove('cm-md-table-active');
      if (openMenu?.owner === this) closeMenu();
    }
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

    if (openMenu?.owner === this) {
      const step: Record<string, [number, number]> = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
      if (e.key in step && plain) {
        handled();
        this.stepMenu(...step[e.key]);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && plain)) {
        handled();
        const menu = openMenu;
        const picked = e.key === 'Enter' && menu.at ? menu.rows[menu.at[0]][menu.at[1]] : null;
        if (picked) picked.click();
        else closeMenu();
        return;
      }
      closeMenu();
    }

    if (e.key.toLowerCase() === 'd' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey) {
      handled();
      this.run('rowDuplicate', { r, c });
    } else if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey) && (e.shiftKey || e.altKey)) {
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

  /** Sorts the body rows by the column of `at` and keeps the focus on the row it was in. */
  sort(at: CellRef, dir: 'asc' | 'desc'): void {
    const model = parseTable(this.widget.source);
    if (!model) return;
    const row = model.rows[at.r];
    if (!applyOp(model, { op: 'sort', col: at.c, dir })) return;
    this.pendingFocus = { r: Math.max(0, model.rows.indexOf(row)), c: at.c };
    this.replaceSource(serializeTable(model, this.padCells), 'input.table');
  }

  copy(at: CellRef, as: 'markdown' | 'tsv'): void {
    const text = as === 'tsv' ? tableToTSV(this.model) : this.widget.source;
    void copyText(text).then(() => {
      // The fallback for a missing clipboard API borrows the focus.
      if (this.dom.isConnected && !this.dom.contains(document.activeElement)) this.focusCell(at.r, at.c, 'end');
    });
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
