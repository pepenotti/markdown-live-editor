// A list that drops down from a toolbar button: the Export menu (role "menu") and the paragraph
// style picker (role "listbox"). Drawn in the page, so it follows the VS Code theme where a native
// <select> would draw the operating system's list. The keyboard works as in VS Code's own menus
// and drop-downs: arrows, Home and End, a letter to jump, Enter to choose, Escape to close.

export type PopupKind = 'menu' | 'listbox';

/**
 * Where a key moves the highlight in a list of `labels`, from `at` (-1 for none), or null when
 * the key does not move it. Disabled entries are skipped. A menu wraps around at the ends, as
 * VS Code's menus do; a list box stops, as its drop-downs do. A letter goes to the next entry that
 * starts with it, going round, so pressing it again steps through the entries that share it.
 */
export function popupKeyTarget(key: string, labels: readonly string[], enabled: readonly boolean[], at: number, wrap: boolean): number | null {
  const usable = labels.map((_, i) => i).filter((i) => enabled[i] !== false);
  if (!usable.length) return null;
  const pos = usable.indexOf(at);
  switch (key) {
    case 'ArrowDown':
      if (pos < 0) return usable[0];
      return pos + 1 < usable.length ? usable[pos + 1] : wrap ? usable[0] : usable[pos];
    case 'ArrowUp':
      if (pos < 0) return usable[usable.length - 1];
      return pos > 0 ? usable[pos - 1] : wrap ? usable[usable.length - 1] : usable[pos];
    case 'Home':
    case 'PageUp':
      return usable[0];
    case 'End':
    case 'PageDown':
      return usable[usable.length - 1];
  }
  if ([...key].length !== 1 || !key.trim()) return null;
  const letter = key.toLocaleLowerCase();
  const start = pos < 0 ? 0 : pos + 1;
  for (let n = 0; n < usable.length; n++) {
    const i = usable[(start + n) % usable.length];
    if (labels[i].trim().toLocaleLowerCase().startsWith(letter)) return i;
  }
  return null;
}

export interface PopupMenuOptions {
  /** The toolbar button that opens it. Gets aria-haspopup and aria-expanded. */
  button: HTMLButtonElement;
  kind: PopupKind;
  label: string;
  /** Extra class for the list. */
  className?: string;
  /** Which edge of the button the list lines up with. */
  align: 'start' | 'end';
  /** The entry highlighted on opening: for a list box the current value. Default: none (a menu). */
  initial?(): number;
  /** An entry was chosen. The list is already closed. */
  onChoose(item: HTMLElement, index: number): void;
}

export interface PopupMenu {
  /** The list. Add the entries (buttons) to it; they get their role here. */
  list: HTMLElement;
  add(item: HTMLButtonElement): void;
  isOpen(): boolean;
  /** `focusItem` moves the keyboard into the list, as opening from the keyboard does. */
  open(focusItem: boolean): void;
  close(): void;
}

export function createPopupMenu(options: PopupMenuOptions): PopupMenu {
  const { button, kind } = options;
  const itemRole = kind === 'menu' ? 'menuitem' : 'option';
  button.setAttribute('aria-haspopup', kind);
  button.setAttribute('aria-expanded', 'false');

  // The toolbar wraps and may scroll when it is narrow, which would clip a list inside it,
  // so the list lives in the page and is placed under the button.
  const list = document.createElement('div');
  list.className = `mdl-menu mdl-menu-${kind}${options.className ? ` ${options.className}` : ''}`;
  list.setAttribute('role', kind);
  list.setAttribute('aria-label', options.label);
  list.hidden = true;

  const items = () => [...list.querySelectorAll<HTMLElement>(`[role="${itemRole}"]`)];
  const isEnabled = (item: HTMLElement) => item.getAttribute('aria-disabled') !== 'true';
  /** The highlighted entry: where the arrow keys are. */
  let active = -1;

  function setActive(index: number, focus: boolean): void {
    const all = items();
    all.forEach((item, i) => item.classList.toggle('mdl-menu-active', i === index));
    active = index;
    const item = all[index];
    if (!item) return;
    if (focus) item.focus();
    else item.scrollIntoView?.({ block: 'nearest' });
  }

  const outside = (e: Event) => {
    if (!list.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  };

  /**
   * While the list is open it has the keyboard, wherever the focus is: opened with the mouse, the
   * focus stays in the text (so the selection is kept), and the keys still go to the list.
   */
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.ctrlKey || e.metaKey || (e.altKey && e.key !== 'ArrowUp')) return;
    const inList = list.contains(document.activeElement);
    if (e.key === 'Escape' || (e.altKey && e.key === 'ArrowUp')) {
      close();
      if (inList) button.focus();
    } else if (e.key === 'Tab') {
      // The focus moves on as usual, and the list goes away.
      close();
      return;
    } else if (e.key === 'Enter' || e.key === ' ') {
      // The highlighted entry, which has the focus when the keyboard is in the list.
      const item = items()[active];
      if (item) choose(item);
      else close();
    } else {
      const all = items();
      const next = popupKeyTarget(
        e.key,
        all.map((item) => item.textContent ?? ''),
        all.map(isEnabled),
        active,
        kind === 'menu',
      );
      if (next === null) {
        // Other keys must not reach the text while the list is open.
        if ([...e.key].length === 1) e.preventDefault(), e.stopPropagation();
        return;
      }
      setActive(next, true);
    }
    e.preventDefault();
    e.stopPropagation();
  };

  function choose(item: HTMLElement): void {
    if (!isEnabled(item)) return;
    const hadFocus = list.contains(document.activeElement);
    const index = items().indexOf(item);
    close();
    if (hadFocus) button.focus();
    options.onChoose(item, index);
  }

  function close(): void {
    if (list.hidden) return;
    list.hidden = true;
    list.remove();
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    window.removeEventListener('resize', close);
  }
  // A window that loses the focus closes the list, but not the focus moving into the list.
  const onBlur = () => close();

  function open(focusItem: boolean): void {
    if (!list.hidden) return;
    const box = button.getBoundingClientRect();
    document.body.append(list);
    list.hidden = false;
    list.style.top = `${Math.round(box.bottom + 2)}px`;
    const page = document.documentElement.clientWidth;
    if (options.align === 'end') {
      list.style.left = '';
      list.style.right = `${Math.max(8, Math.round(page - box.right))}px`;
    } else {
      list.style.right = '';
      list.style.left = `${Math.max(8, Math.round(box.left))}px`;
      list.style.minWidth = `${Math.round(box.width)}px`;
    }
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', close);
    const all = items();
    let start = options.initial?.() ?? -1;
    if (!all[start] || !isEnabled(all[start])) start = focusItem ? all.findIndex(isEnabled) : -1;
    setActive(start, focusItem);
  }

  // Clicks keep the selection in the text: the list never takes the focus from the mouse.
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const item = (e.target as Element).closest<HTMLElement>(`[role="${itemRole}"]`);
    if (item && list.contains(item)) choose(item);
  });
  if (kind === 'menu') {
    // In a menu the pointer moves the highlight, as in VS Code's menus.
    list.addEventListener('mousemove', (e) => {
      const item = (e.target as Element).closest<HTMLElement>(`[role="${itemRole}"]`);
      const index = item ? items().indexOf(item) : -1;
      if (item && index !== active && isEnabled(item)) setActive(index, list.contains(document.activeElement));
    });
  }

  button.addEventListener('mousedown', (e) => e.preventDefault());
  // A click from the keyboard (Enter or Space) has no detail and moves the keyboard into the list.
  button.addEventListener('click', (e) => (list.hidden ? open(e.detail === 0) : close()));
  button.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    if (!list.hidden) return; // The open list handles it.
    e.preventDefault();
    open(true);
  });

  return {
    list,
    add(item) {
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', itemRole);
      list.append(item);
    },
    isOpen: () => !list.hidden,
    open,
    close,
  };
}
