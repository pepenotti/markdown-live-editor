// The outline panel docked on the right of the editor: the document's headings, the one the
// reader is in highlighted, a filter box, and a click (or Enter) to jump. Its left edge is a sash,
// as in VS Code: drag it to resize the panel, drag it narrow to close it, double-click it for the
// default width. Closed, the sash stays at the right edge of the editor and can be dragged out.
// The list is built from the syntax tree; see ../outline.ts for the model.
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { dragOutlineWidth, normalizeOutlineWidth, OUTLINE_DEFAULT_WIDTH } from '../../shared/outlineWidth';
import { currentHeading, filterOutline, type OutlineItem, outlineFromTree, outlineMayChange, sameOutline } from '../outline';

/** Below this window width the panel floats over the text instead of taking room from it. */
export const OUTLINE_OVERLAY_WIDTH = 720;
/** How long typing waits before the outline is rebuilt. */
const REBUILD_DELAY = 300;
/** A scroll this long after the cursor moved is taken to be the reader scrolling. */
const SCROLL_AFTER_SELECT = 250;

export interface OutlinePanel {
  dom: HTMLElement;
  attach(view: EditorView): void;
  update(update: ViewUpdate): void;
  isOpen(): boolean;
  /**
   * Opens or closes the panel. `focus` puts the keyboard in the filter box when opening.
   * `remember` tells the host, so that the next editor starts the same way.
   */
  setOpen(open: boolean, options?: { focus?: boolean; remember?: boolean }): void;
  /** The panel's width while open, in pixels (it is narrower where the editor has no room for it). */
  width(): number;
  /** Sets the width; `remember` tells the host. A width that makes no sense means the default. */
  setWidth(width: number | undefined, options?: { remember?: boolean }): void;
}

export interface OutlineOptions {
  /** The panel was opened or closed by the user; `open` is to be remembered. */
  onChange(open: boolean): void;
  /** The user resized the panel; `width` is to be remembered. */
  onResize?(width: number): void;
  /** The panel's toggle shortcut was pressed inside the panel. */
  onToggleKey?(): void;
}

const isToggleKey = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === 'KeyO';

export function createOutlinePanel(options: OutlineOptions): OutlinePanel {
  const narrow = window.matchMedia(`(max-width: ${OUTLINE_OVERLAY_WIDTH - 1}px)`);

  const dom = document.createElement('aside');
  dom.className = 'mdl-outline';
  dom.setAttribute('aria-label', 'Outline');

  // Only the mouse uses the sash; the keyboard has the toolbar button and Alt+O.
  const sash = document.createElement('div');
  sash.className = 'mdl-outline-sash';
  sash.setAttribute('aria-hidden', 'true');

  const body = document.createElement('div');
  body.className = 'mdl-outline-body';
  body.id = 'mdl-outline-body';

  const head = document.createElement('div');
  head.className = 'mdl-outline-head';
  const filter = document.createElement('input');
  filter.type = 'text';
  filter.className = 'mdl-outline-filter';
  filter.placeholder = 'Filter headings';
  filter.setAttribute('aria-label', 'Filter headings');
  filter.setAttribute('aria-controls', 'mdl-outline-list');
  filter.spellcheck = false;
  filter.autocomplete = 'off';
  head.append(filter);

  const list = document.createElement('div');
  list.className = 'mdl-outline-list';
  list.id = 'mdl-outline-list';
  list.setAttribute('role', 'tree');
  list.setAttribute('aria-label', 'Headings');
  list.tabIndex = 0;

  const empty = document.createElement('div');
  empty.className = 'mdl-outline-empty';

  body.append(head, list, empty);
  dom.append(sash, body);

  let view: EditorView | undefined;
  let open = false;
  let width = OUTLINE_DEFAULT_WIDTH;
  let items: OutlineItem[] = [];
  let rows: HTMLElement[] = [];
  /** Whether `items` may be out of date (it is not kept up to date while the panel is closed). */
  let dirty = true;
  /** Whether the last build saw the whole document, or only what the parser had reached. */
  let complete = false;
  let shown: ReturnType<typeof filterOutline> = null;
  /** The highlighted heading: where the reader is. */
  let current = -1;
  /** The heading the arrow keys are on, or -1. */
  let cursor = -1;
  let follow: 'cursor' | 'scroll' = 'cursor';
  let lastSelect = 0;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let highlightFrame = 0;

  /* ---------- building ---------- */

  function rebuild(): void {
    clearTimeout(rebuildTimer);
    rebuildTimer = undefined;
    if (!view) return;
    const state = view.state;
    const tree = ensureSyntaxTree(state, state.doc.length, 40) ?? syntaxTree(state);
    complete = tree.length >= state.doc.length;
    const next = outlineFromTree(tree, (from, to) => state.doc.sliceString(from, to));
    dirty = false;
    if (sameOutline(items, next)) {
      items = next;
    } else {
      items = next;
      render();
    }
    highlight();
  }

  function scheduleRebuild(): void {
    if (!open) {
      dirty = true;
      return;
    }
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, REBUILD_DELAY);
  }

  function render(): void {
    rows = items.map((item, i) => {
      const row = document.createElement('div');
      row.className = 'mdl-outline-item';
      row.id = `mdl-outline-item-${i}`;
      row.dataset.index = String(i);
      row.dataset.level = String(item.level);
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(item.depth + 1));
      row.style.setProperty('--mdl-outline-depth', String(item.depth));
      return row;
    });
    list.replaceChildren(...rows);
    if (cursor >= items.length) cursor = -1;
    applyFilter();
  }

  /** Shows the rows the filter lets through, with the matching text marked. */
  function applyFilter(): void {
    shown = filterOutline(items, filter.value);
    const query = filter.value.trim().toLowerCase();
    rows.forEach((row, i) => {
      const text = items[i].text;
      row.hidden = !!shown && !shown.visible.has(i);
      row.classList.toggle('mdl-outline-context', !!shown && !shown.matches.has(i));
      row.title = text;
      const label = document.createElement('span');
      label.className = 'mdl-outline-text';
      const at = shown?.matches.has(i) ? text.toLowerCase().indexOf(query) : -1;
      if (!text) {
        label.textContent = 'Empty heading';
        label.classList.add('mdl-outline-untitled');
      } else if (at >= 0) {
        const mark = document.createElement('mark');
        mark.textContent = text.slice(at, at + query.length);
        label.append(text.slice(0, at), mark, text.slice(at + query.length));
      } else {
        label.textContent = text;
      }
      row.replaceChildren(label);
    });
    if (cursor >= 0 && rows[cursor]?.hidden) cursor = -1;
    // While filtering, Enter goes to the first match unless the arrow keys chose another heading.
    if (shown && cursor < 0) cursor = shown.matches.size ? Math.min(...shown.matches) : -1;
    if (!shown) cursor = Math.min(cursor, items.length - 1);
    empty.textContent = !items.length ? 'No headings in this document.' : shown && !shown.visible.size ? 'No headings match.' : '';
    empty.hidden = !empty.textContent;
    markCursor();
  }

  function visibleRows(): number[] {
    const out: number[] = [];
    rows.forEach((row, i) => row.hidden || out.push(i));
    return out;
  }

  /* ---------- where the reader is ---------- */

  function topOfView(v: EditorView): number {
    const offset = v.scrollDOM.getBoundingClientRect().top - v.documentTop;
    return v.lineBlockAtHeight(Math.max(0, offset) + 16).from;
  }

  function highlight(): void {
    cancelAnimationFrame(highlightFrame);
    highlightFrame = 0;
    if (!view || !open) return;
    const next = currentHeading(items, { cursor: view.state.selection.main.head, top: topOfView(view), follow });
    if (next === current && rows[current]?.classList.contains('mdl-outline-current')) return;
    rows[current]?.classList.remove('mdl-outline-current');
    rows[current]?.removeAttribute('aria-current');
    current = next;
    const row = rows[current];
    if (!row) return;
    row.classList.add('mdl-outline-current');
    row.setAttribute('aria-current', 'location');
    if (cursor < 0) reveal(row);
  }

  function scheduleHighlight(): void {
    if (open && !highlightFrame) highlightFrame = requestAnimationFrame(highlight);
  }

  /** Scrolls the list, and nothing around it, so that a row is in sight. */
  function reveal(row: HTMLElement): void {
    if (row.hidden) return;
    const top = row.offsetTop - list.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }

  /* ---------- keyboard and mouse ---------- */

  function markCursor(): void {
    for (const row of list.querySelectorAll('.mdl-outline-cursor')) row.classList.remove('mdl-outline-cursor');
    const row = rows[cursor];
    if (row && !row.hidden) {
      row.classList.add('mdl-outline-cursor');
      list.setAttribute('aria-activedescendant', row.id);
      filter.setAttribute('aria-activedescendant', row.id);
      reveal(row);
    } else {
      list.removeAttribute('aria-activedescendant');
      filter.removeAttribute('aria-activedescendant');
    }
  }

  function moveCursor(step: number | 'first' | 'last'): void {
    const visible = visibleRows();
    if (!visible.length) return;
    let at: number;
    if (step === 'first') at = 0;
    else if (step === 'last') at = visible.length - 1;
    else if (visible.includes(cursor)) at = visible.indexOf(cursor) + step;
    // The first arrow press starts on the highlighted heading, where the reader is.
    else if (visible.includes(current)) at = visible.indexOf(current);
    else at = step > 0 ? 0 : visible.length - 1;
    cursor = visible[Math.max(0, Math.min(visible.length - 1, at))];
    markCursor();
  }

  /** Moves the cursor of the editor to a heading and scrolls it to the top. */
  function jump(index: number, focusEditor: boolean): void {
    const item = items[index];
    if (!view || !item) return;
    const pos = Math.min(item.from, view.state.doc.length);
    follow = 'cursor';
    lastSelect = Date.now();
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 8 }), userEvent: 'select' });
    cursor = index;
    markCursor();
    if (narrow.matches) {
      setOpen(false);
      view.focus();
    } else if (focusEditor) {
      view.focus();
    }
  }

  list.addEventListener('click', (e) => {
    const row = (e.target as Element).closest<HTMLElement>('.mdl-outline-item');
    if (row) jump(Number(row.dataset.index), false);
  });

  body.addEventListener('keydown', (e) => {
    if (isToggleKey(e)) {
      e.preventDefault();
      options.onToggleKey?.();
      return;
    }
    const inFilter = e.target === filter;
    switch (e.key) {
      case 'ArrowDown':
        moveCursor(1);
        break;
      case 'ArrowUp':
        moveCursor(-1);
        break;
      case 'Home':
      case 'End':
        if (inFilter) return;
        moveCursor(e.key === 'Home' ? 'first' : 'last');
        break;
      case 'Enter': {
        const target = cursor >= 0 && !rows[cursor]?.hidden ? cursor : (visibleRows()[0] ?? -1);
        if (target >= 0) jump(target, true);
        break;
      }
      case 'Escape':
        if (narrow.matches) setOpen(false);
        view?.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  filter.addEventListener('input', () => {
    cursor = -1;
    applyFilter();
    if (!shown && rows[current]) reveal(rows[current]);
  });

  /* ---------- opening and closing ---------- */

  function showState(): void {
    dom.classList.toggle('mdl-outline-open', open);
    body.hidden = !open;
  }

  function showWidth(): void {
    dom.style.setProperty('--mdl-outline-width', `${width}px`);
  }

  function setWidth(next: number | undefined, opts: { remember?: boolean } = {}): void {
    width = normalizeOutlineWidth(next) ?? OUTLINE_DEFAULT_WIDTH;
    showWidth();
    if (opts.remember) options.onResize?.(width);
  }

  /* ---------- the sash ---------- */

  sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !dom.parentElement) return;
    // No text selection, and the focus stays where it is.
    e.preventDefault();
    const area = dom.parentElement.getBoundingClientRect().width;
    const startX = e.clientX;
    const startOpen = open;
    const startWidth = width;
    // What is on screen, which can be less than `width` where the editor is narrow.
    const from = open ? dom.getBoundingClientRect().width : 0;
    let moved = false;
    sash.setPointerCapture?.(e.pointerId);
    sash.classList.add('mdl-sash-active');
    document.body.classList.add('mdl-sash-dragging');

    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 2) return;
      moved = true;
      const next = dragOutlineWidth(from + startX - ev.clientX, area);
      if (next.open) {
        width = next.width;
        showWidth();
      }
      if (next.open !== open) setOpen(next.open);
    };
    const end = () => {
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', end);
      sash.removeEventListener('pointercancel', end);
      sash.classList.remove('mdl-sash-active');
      document.body.classList.remove('mdl-sash-dragging');
      if (!moved) return;
      // Snapped shut, the panel keeps the width it had, as VS Code's side bar does.
      if (!open) {
        width = startWidth;
        showWidth();
      }
      if (open !== startOpen) options.onChange(open);
      if (width !== startWidth) options.onResize?.(width);
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', end);
    sash.addEventListener('pointercancel', end);
  });

  sash.addEventListener('dblclick', () => {
    if (width !== OUTLINE_DEFAULT_WIDTH) setWidth(OUTLINE_DEFAULT_WIDTH, { remember: true });
    if (!open) setOpen(true, { remember: true });
  });

  function setOpen(next: boolean, opts: { focus?: boolean; remember?: boolean } = {}): void {
    const hadFocus = dom.contains(document.activeElement);
    if (next !== open) {
      open = next;
      showState();
      if (open) {
        if (dirty || !complete) rebuild();
        current = -1;
        follow = 'cursor';
        highlight();
      } else {
        clearTimeout(rebuildTimer);
        rebuildTimer = undefined;
        cursor = -1;
        markCursor();
      }
      if (opts.remember) options.onChange(open);
    }
    if (open && opts.focus) {
      filter.focus();
      filter.select();
    } else if (!open && hadFocus) {
      view?.focus();
    }
  }

  // A click in the text closes the panel where it covers the text.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (open && narrow.matches && !dom.contains(e.target as Node) && !(e.target as Element).closest?.('.mdl-toolbar')) setOpen(false);
    },
    true,
  );

  showState();
  showWidth();

  return {
    dom,
    attach(v) {
      view = v;
      v.scrollDOM.addEventListener('scroll', () => {
        if (!open) return;
        if (Date.now() - lastSelect > SCROLL_AFTER_SELECT) follow = 'scroll';
        scheduleHighlight();
      });
    },
    update(u) {
      // Closed, the panel does no work at all; it rebuilds when it is opened.
      if (!open) {
        if (u.docChanged) dirty = true;
        return;
      }
      if (u.docChanged) {
        for (const item of items) item.from = u.changes.mapPos(item.from, 1);
        if (outlineMayChange(u.startState.doc, u.state.doc, u.changes)) scheduleRebuild();
      }
      if (!complete && syntaxTree(u.startState) !== syntaxTree(u.state)) scheduleRebuild();
      if (u.selectionSet || u.docChanged) {
        follow = 'cursor';
        lastSelect = Date.now();
      }
      if (u.selectionSet || u.docChanged || u.geometryChanged) scheduleHighlight();
    },
    isOpen: () => open,
    setOpen,
    width: () => width,
    setWidth,
  };
}
