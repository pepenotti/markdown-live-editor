// A find bar that looks and behaves like VS Code's: it floats at the top right, counts
// matches ("3 of 12"), and highlights them in the theme's find colours.
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  search,
  setSearchQuery,
} from '@codemirror/search';
import type { EditorState, Extension } from '@codemirror/state';
import type { EditorView, Panel, ViewUpdate } from '@codemirror/view';

/** Matches are counted up to this many; beyond it the count shows "10000+". */
const COUNT_LIMIT = 10000;

/** How many matches there are, and which one the selection is on (1-based, 0 for none). */
export function matchCount(state: EditorState, query: SearchQuery): { total: number; current: number; capped: boolean } {
  if (!query.search || !query.valid) return { total: 0, current: 0, capped: false };
  const sel = state.selection.main;
  const cursor = query.getCursor(state) as Iterator<{ from: number; to: number }>;
  let total = 0;
  let current = 0;
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    total++;
    if (next.value.from === sel.from && next.value.to === sel.to) current = total;
    if (total >= COUNT_LIMIT) return { total, current, capped: true };
  }
  return { total, current, capped: false };
}

function iconButton(label: string, title: string, run: () => void, toggle = false): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = toggle ? 'mdl-find-toggle' : 'mdl-find-button';
  b.textContent = label;
  b.title = title;
  b.setAttribute('aria-label', title);
  if (toggle) b.setAttribute('aria-pressed', 'false');
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', run);
  return b;
}

function createFindPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'mdl-find';
  dom.setAttribute('role', 'search');

  const query0 = getSearchQuery(view.state);
  let caseSensitive = query0.caseSensitive;
  let wholeWord = query0.wholeWord;
  let regexp = query0.regexp;
  let replaceOpen = query0.replace !== '';

  const expand = iconButton('›', 'Toggle Replace', () => {
    replaceOpen = !replaceOpen;
    render();
    (replaceOpen ? replaceInput : searchInput).focus();
  });
  expand.classList.add('mdl-find-expand');

  const searchInput = document.createElement('input');
  searchInput.className = 'mdl-find-input';
  searchInput.placeholder = 'Find';
  searchInput.setAttribute('aria-label', 'Find');
  searchInput.setAttribute('main-field', 'true');
  searchInput.spellcheck = false;
  searchInput.value = query0.search;

  const caseButton = iconButton('Aa', 'Match Case', () => {
    caseSensitive = !caseSensitive;
    commit();
  }, true);
  const wordButton = iconButton('ab', 'Match Whole Word', () => {
    wholeWord = !wholeWord;
    commit();
  }, true);
  const regexpButton = iconButton('.*', 'Use Regular Expression', () => {
    regexp = !regexp;
    commit();
  }, true);
  wordButton.classList.add('mdl-find-word');

  const count = document.createElement('span');
  count.className = 'mdl-find-count';
  count.setAttribute('aria-live', 'polite');

  const prev = iconButton('↑', 'Previous Match (Shift+Enter)', () => findPrevious(view));
  const next = iconButton('↓', 'Next Match (Enter)', () => findNext(view));
  const close = iconButton('×', 'Close (Escape)', () => {
    closeSearchPanel(view);
    view.focus();
  });

  const replaceInput = document.createElement('input');
  replaceInput.className = 'mdl-find-input';
  replaceInput.placeholder = 'Replace';
  replaceInput.setAttribute('aria-label', 'Replace');
  replaceInput.spellcheck = false;
  replaceInput.value = query0.replace;
  const replaceOne = iconButton('Replace', 'Replace (Enter)', () => replaceNext(view));
  const replaceEvery = iconButton('All', 'Replace All', () => replaceAll(view));

  const findRow = document.createElement('div');
  findRow.className = 'mdl-find-row';
  const field = document.createElement('div');
  field.className = 'mdl-find-field';
  field.append(searchInput, caseButton, wordButton, regexpButton);
  findRow.append(field, count, prev, next, close);

  const replaceRow = document.createElement('div');
  replaceRow.className = 'mdl-find-row';
  const replaceField = document.createElement('div');
  replaceField.className = 'mdl-find-field';
  replaceField.append(replaceInput);
  replaceRow.append(replaceField, replaceOne, replaceEvery);

  const rows = document.createElement('div');
  rows.className = 'mdl-find-rows';
  rows.append(findRow, replaceRow);
  dom.append(expand, rows);

  let shown: SearchQuery = query0;

  function commit(): void {
    const query = new SearchQuery({ search: searchInput.value, caseSensitive, wholeWord, regexp, replace: replaceInput.value });
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) });
    shown = query;
    render();
  }

  function render(): void {
    caseButton.setAttribute('aria-pressed', String(caseSensitive));
    wordButton.setAttribute('aria-pressed', String(wholeWord));
    regexpButton.setAttribute('aria-pressed', String(regexp));
    replaceRow.hidden = !replaceOpen;
    expand.textContent = replaceOpen ? '⌄' : '›';
    expand.setAttribute('aria-expanded', String(replaceOpen));
    const query = getSearchQuery(view.state);
    if (query.search && !query.valid) {
      count.textContent = 'Invalid';
      dom.classList.add('mdl-find-error');
      return;
    }
    dom.classList.remove('mdl-find-error');
    const { total, current, capped } = matchCount(view.state, query);
    const all = capped ? `${total}+` : String(total);
    count.textContent = !query.search ? 'No results' : total === 0 ? 'No results' : current ? `${current} of ${all}` : `? of ${all}`;
    dom.classList.toggle('mdl-find-none', !!query.search && total === 0);
    prev.disabled = next.disabled = total === 0;
    replaceOne.disabled = replaceEvery.disabled = total === 0;
  }

  searchInput.addEventListener('input', commit);
  replaceInput.addEventListener('input', commit);
  const keys = (e: KeyboardEvent, onEnter: () => void) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else onEnter();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    } else if (e.key === 'F3' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g')) {
      e.preventDefault();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      searchInput.select();
    }
  };
  searchInput.addEventListener('keydown', (e) => keys(e, () => findNext(view)));
  replaceInput.addEventListener('keydown', (e) => keys(e, () => replaceNext(view)));

  render();

  return {
    dom,
    top: true,
    mount() {
      searchInput.focus();
      searchInput.select();
    },
    update(update: ViewUpdate) {
      const query = getSearchQuery(update.state);
      if (!query.eq(shown)) {
        // The query was changed from outside, for example by Mod+F with a selection.
        shown = query;
        if (document.activeElement !== searchInput) searchInput.value = query.search;
        if (document.activeElement !== replaceInput) replaceInput.value = query.replace;
        caseSensitive = query.caseSensitive;
        wholeWord = query.wholeWord;
        regexp = query.regexp;
      }
      if (update.docChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((e) => e.is(setSearchQuery)))) render();
    },
  };
}

export function findWidget(): Extension {
  return search({ top: true, createPanel: createFindPanel });
}
