// Entry point of the webview: builds the CodeMirror editor and wires it to the host.
import { closeBrackets } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { codeFolding, ensureSyntaxTree, foldCode, indentUnit, syntaxHighlighting, syntaxTree, unfoldCode } from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { drawSelection, dropCursor, EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { classHighlighter, tagHighlighter, tags } from '@lezer/highlight';
import {
  type CheckLinksResult,
  type CommandId,
  type EditorConfig,
  type HostMessage,
  isImagePath,
  type LinkedFile,
  type Mode,
  MODES,
} from '../shared/protocol';
import { findHeading, scanDocument } from '../shared/linkCheck';
import { countWords, extractHeadings, headingSlugs, slugify } from '../shared/textUtil';
import { DEFAULT_TOC_OPTIONS } from '../shared/toc';
import {
  type FormatCommand,
  insertBlock,
  insertCodeBlock,
  insertLink,
  insertPaths,
  insertRule,
  insertTable,
  insertToc,
  pasteMarkdown,
  setHeading,
  shiftHeading,
  toggleInline,
  toggleList,
  toggleQuote,
  toggleTask,
} from './commands/format';
import { hostActions, makeResolver, renderConfig, type RenderConfig } from './config';
import { blockField } from './decorations/blocks';
import { inlinePlugin } from './decorations/inline';
import { editingBehaviour } from './fullMode';
import { editGuard } from './guard';
import { HostBridge } from './host';
import { type Conversion, hasFormattedText, markdownForPaste } from './htmlToMarkdown';
import { brokenLinkMessages, linkCheck } from './linkCheck';
import { focusPopover, popoverField } from './linkPopover';
import { footnoteAt, footnotes, linkInfo } from './links';
import { markdownSupport } from './markdown';
import { cursorFix, externalChange, modeField, setMode } from './modes';
import { SyncClient } from './syncClient';
import { tableFromTSV } from './table/model';
import { completions, insideCode } from './ui/completions';
import { createToolbar, type Toolbar } from './ui/toolbar';
import { activeTableCell, focusTableAt, wrapInActiveCell } from './widgets/table';
import { wikiLinkAt } from './wikiLinks';

const host = new HostBridge();
const problems: string[] = [];
const report = (message: string) => {
  problems.push(message);
  host.log('error', message);
};
window.addEventListener('error', (e) => report(`${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => report(`Unhandled rejection: ${String(e.reason)}`));
document.addEventListener('securitypolicyviolation', (e) => report(`CSP blocked ${e.violatedDirective}: ${e.blockedURI || 'inline'}`));

const nonce = document.querySelector<HTMLMetaElement>('meta[name="mdl-nonce"]')?.content ?? '';
const app = document.getElementById('app')!;

let view: EditorView | undefined;
let sync: SyncClient | undefined;
let toolbar: Toolbar | undefined;
let config: EditorConfig;
let isMac = /Mac/.test(navigator.platform);
let testSession = false;
let resolveUrl: (src: string) => string = (s) => s;
const renderCompartment = new Compartment();
const links = linkCheck({
  check: async (targets) => (await host.request<CheckLinksResult>('checkLinks', { targets })).issues,
  onError: (message) => report(message),
});
const languageCompartment = new Compartment();
/** Whether the parser currently knows wiki links. */
let wikiLinks = false;
const language = (): Extension => markdownSupport({ wikiLinks });

const markdownHighlighter = tagHighlighter([
  { tag: tags.monospace, class: 'tok-monospace' },
  { tag: tags.quote, class: 'tok-quote' },
  { tag: tags.strikethrough, class: 'tok-strikethrough' },
  { tag: tags.processingInstruction, class: 'tok-mark' },
  { tag: tags.contentSeparator, class: 'tok-mark' },
  { tag: tags.list, class: 'tok-list' },
]);

/* ---------- configuration ---------- */

function measureMonoRatio(): number {
  const probe = document.createElement('span');
  probe.className = 'mdl-mono-probe';
  probe.textContent = '0'.repeat(20);
  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  const ratio = width / 20 / 100;
  return ratio > 0.3 && ratio < 1 ? ratio : 0.6;
}

function currentRenderConfig(): RenderConfig {
  return { resolveUrl, monoRatio: measureMonoRatio(), tableAutoAlign: config.tableAutoAlign, spellCheck: !!config.spellCheck };
}

function applyConfig(next: EditorConfig): void {
  config = next;
  const root = document.body.style;
  root.setProperty('--mdl-font-size', `${next.fontSize}px`);
  if (next.fontFamily.trim()) root.setProperty('--mdl-font', next.fontFamily);
  else root.removeProperty('--mdl-font');
  root.setProperty('--mdl-line-width', next.lineWidth > 0 ? `${next.lineWidth}px` : 'none');
  let custom = document.getElementById('mdl-custom-css') as HTMLStyleElement | null;
  if (!custom) {
    custom = document.createElement('style');
    custom.id = 'mdl-custom-css';
    custom.nonce = nonce;
    document.head.append(custom);
  }
  custom.textContent = next.customCss ?? '';
  toolbar?.setVisible(next.showToolbar);
  for (const cell of document.querySelectorAll<HTMLElement>('.cm-md-cell')) cell.spellcheck = !!next.spellCheck;
  links.setEnabled(next.checkLinks !== false);
  view?.dispatch({ effects: renderCompartment.reconfigure(renderConfig.of(currentRenderConfig())) });
  if (view && !!next.wikiLinks !== wikiLinks) {
    wikiLinks = !!next.wikiLinks;
    view.dispatch({ effects: languageCompartment.reconfigure(language()) });
    // Double brackets mean something else now, to the link checker as well.
    links.recheck();
  }
}

/* ---------- commands ---------- */

const INLINE_MARKERS = { bold: '**', italic: '*', strike: '~~', code: '`' } as const;

function apply(command: FormatCommand): void {
  if (!view) return;
  const spec = command(view.state);
  if (spec) view.dispatch(spec);
  view.focus();
}

function setEditorMode(mode: Mode): void {
  if (!view || view.state.field(modeField) === mode) return;
  sync?.flush();
  const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop).from;
  view.dispatch({ effects: [setMode.of(mode), EditorView.scrollIntoView(top, { y: 'start' })] });
  if (!activeTableCell()) view.focus();
}

function revealLine(line: number): void {
  if (!view) return;
  const doc = view.state.doc;
  const pos = doc.line(Math.max(1, Math.min(doc.lines, line + 1))).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 24 }) });
  view.focus();
}

function revealAnchor(anchor: string): void {
  if (!view) return;
  let name = anchor.replace(/^#/, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded after all.
  }
  const state = view.state;
  const text = state.doc.toString();
  const headings = extractHeadings(text);
  const index = headingSlugs(headings).indexOf(slugify(name));
  if (index >= 0) return revealLine(headings[index].line);
  // What the line scan does not see but the link check accepts: setext headings and headings inside quotes or lists.
  const tree = ensureSyntaxTree(state, state.doc.length, 500) ?? syntaxTree(state);
  const heading = findHeading(scanDocument(tree, text).headings, name);
  if (heading) revealLine(state.doc.lineAt(heading.from).number - 1);
}

function openLink(href: string): void {
  if (href.startsWith('#')) revealAnchor(href);
  else if (href) host.post({ type: 'openLink', href });
}

function openWikiLink(target: string, heading: string): void {
  if (target) host.post({ type: 'openWikiLink', target, heading });
  else if (heading) revealAnchor(encodeURIComponent(heading));
}

async function pickImages(): Promise<LinkedFile[]> {
  try {
    return (await host.request<{ items: LinkedFile[] }>('pickImage')).items;
  } catch (err) {
    report(`Could not choose an image: ${String(err)}`);
    return [];
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.readAsDataURL(file);
  });
}

/** Saves pasted or dropped image files next to the document and links them. */
async function insertImageFiles(files: File[], at?: number): Promise<void> {
  const items: LinkedFile[] = [];
  for (const file of files) {
    try {
      const base64 = await fileToBase64(file);
      const saved = await host.request<LinkedFile>('saveImage', { name: file.name || 'image.png', base64 });
      items.push(saved);
    } catch (err) {
      report(`Could not save the image: ${String(err)}`);
    }
  }
  if (!view || !items.length) return;
  const pos = at === undefined ? undefined : Math.min(at, view.state.doc.length);
  const spec = insertPaths(items, pos)(view.state);
  if (spec) view.dispatch(spec);
}

function headingLevelAt(state: EditorState): number {
  const m = /^ {0,3}(#{1,6})(?:[ \t]|$)/.exec(state.doc.lineAt(state.selection.main.head).text);
  return m ? m[1].length : 0;
}

function runCommand(id: CommandId, arg?: unknown): void {
  const v = view;
  if (!v) return;
  const active = document.activeElement;
  const inField = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
  switch (id) {
    case 'bold':
    case 'italic':
    case 'strike':
    case 'code':
      if (wrapInActiveCell(INLINE_MARKERS[id]) || inField) return;
      return apply(toggleInline(id));
    case 'link':
      if (inField || activeTableCell()) return;
      apply(insertLink);
      if (v.state.field(modeField) === 'full') focusPopover(v);
      return;
    case 'image':
      void pickImages().then((items) => {
        if (items.length) apply(insertPaths(items));
      });
      return;
    case 'insertImagePaths':
      return apply(insertPaths(arg as LinkedFile[]));
    case 'table': {
      apply(insertTable(3, 3));
      if (v.state.field(modeField) !== 'raw') {
        const start = v.state.doc.lineAt(v.state.selection.main.from).from;
        requestAnimationFrame(() => focusTableAt(v, start, 'first', true));
      }
      return;
    }
    case 'codeBlock':
      return apply(insertCodeBlock);
    case 'rule':
      return apply(insertRule);
    case 'toc':
      return apply(insertToc(config.toc ?? DEFAULT_TOC_OPTIONS));
    case 'bulletList':
      return apply(toggleList('bullet'));
    case 'orderedList':
      return apply(toggleList('ordered'));
    case 'taskList':
      return apply(toggleList('task'));
    case 'toggleTask':
      return apply(toggleTask);
    case 'quote':
      return apply(toggleQuote);
    case 'heading':
      return apply(setHeading(Number(arg) || 1));
    case 'headingUp':
      return apply(shiftHeading(1));
    case 'headingDown':
      return apply(shiftHeading(-1));
    case 'find':
      openSearchPanel(v);
      return;
    case 'setMode':
      if (MODES.includes(arg as Mode)) setEditorMode(arg as Mode);
      return;
    case 'cycleMode': {
      const next = MODES[(MODES.indexOf(v.state.field(modeField)) + 1) % MODES.length];
      setEditorMode(next);
      return;
    }
    case 'revealLine':
      return revealLine(Number(arg) || 0);
    case 'revealAnchor':
      return revealAnchor(String(arg ?? ''));
    case 'recheckLinks':
      return links.recheck();
    case 'focus':
      v.focus();
      return;
  }
}

/** Keys that VS Code turns into commands. In VS Code they are only swallowed here. */
const KEYS: { key: string; id: CommandId }[] = [
  { key: 'Mod-b', id: 'bold' },
  { key: 'Mod-i', id: 'italic' },
  { key: 'Alt-Shift-5', id: 'strike' },
  { key: 'Mod-e', id: 'code' },
  { key: 'Mod-l', id: 'link' },
  { key: 'Mod-Shift-8', id: 'bulletList' },
  { key: 'Mod-Shift-7', id: 'orderedList' },
  { key: 'Mod-Shift-9', id: 'quote' },
  { key: 'Alt-c', id: 'toggleTask' },
  { key: 'Ctrl-Shift-]', id: 'headingUp' },
  { key: 'Ctrl-Shift-[', id: 'headingDown' },
  { key: 'Alt-m', id: 'cycleMode' },
  { key: 'Mod-f', id: 'find' },
];

/* ---------- events ---------- */

function hrefAt(state: EditorState, pos: number): string | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Link' || n.name === 'Image') return linkInfo(state, n)?.href ?? null;
    if (n.name === 'URL') return state.doc.sliceString(n.from, n.to).replace(/^<|>$/g, '');
    if (n.name === 'Autolink') {
      const url = n.getChild('URL');
      return url ? state.doc.sliceString(url.from, url.to) : null;
    }
  }
  return null;
}

/** When Shift+V was last pressed with the paste modifier: the mark of "paste as plain text". */
let plainPasteKey = 0;

/** Where Ctrl/Cmd+click on a footnote leads: from a reference to its text, from the text back to the reference. */
function footnoteTarget(state: EditorState, pos: number): number | null {
  const note = footnoteAt(state, pos);
  if (!note) return null;
  const all = footnotes(state);
  return (note.reference ? all.definitions : all.references).get(note.id) ?? null;
}

const domHandlers = EditorView.domEventHandlers({
  keydown(event) {
    // A paste event does not say that Shift was held. Chromium's "paste and match style" (Ctrl/Cmd+Shift+V)
    // hands over a clipboard with only text/plain, but nothing promises that everywhere, and the
    // link and table shortcuts work from the plain text, so the key press is remembered as well.
    plainPasteKey = event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v' ? Date.now() : 0;
    return false;
  },
  mousedown(event, v) {
    if (event.button !== 0 || !(isMac ? event.metaKey : event.ctrlKey)) return false;
    const pos = v.posAtCoords({ x: event.clientX, y: event.clientY });
    const wiki = pos === null ? null : wikiLinkAt(v.state, pos);
    if (wiki) {
      event.preventDefault();
      openWikiLink(wiki.target, wiki.heading);
      return true;
    }
    const note = pos === null ? null : footnoteTarget(v.state, pos);
    if (note !== null) {
      event.preventDefault();
      v.dispatch({ selection: { anchor: note }, effects: EditorView.scrollIntoView(note, { y: 'center' }), userEvent: 'select' });
      v.focus();
      return true;
    }
    const href = pos === null ? null : (hrefAt(v.state, pos) ?? hrefAt(v.state, Math.min(pos + 1, v.state.doc.length)));
    if (!href) return false;
    event.preventDefault();
    openLink(href);
    return true;
  },
  paste(event, v) {
    const data = event.clipboardData;
    if (!data) return false;
    const images = Array.from(data.files).filter((f) => f.type.startsWith('image/'));
    const text = data.getData('text/plain');
    if (images.length && !hasFormattedText(text, data.getData('text/html'))) {
      event.preventDefault();
      void insertImageFiles(images);
      return true;
    }
    // Pasting with Shift held asks for the plain text exactly as it is: no link, table or Markdown conversion.
    const plain = Date.now() - plainPasteKey < 1000;
    plainPasteKey = 0;
    if (plain) return false;
    const sel = v.state.selection.main;
    if (insideCode(v.state, sel.from)) return false;
    const selected = v.state.doc.sliceString(sel.from, sel.to);
    const url = text.trim();
    if (!sel.empty && !selected.includes('\n') && /^(?:https?:\/\/|mailto:)\S+$/i.test(url) && !/^(?:https?:\/\/|mailto:)/i.test(selected) && !hrefAt(v.state, sel.from)) {
      event.preventDefault();
      const insert = `[${selected}](${url})`;
      v.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: { anchor: sel.from + insert.length }, userEvent: 'input.paste' });
      return true;
    }
    const table = tableFromTSV(text);
    if (table) {
      event.preventDefault();
      if (!sel.empty) v.dispatch({ changes: { from: sel.from, to: sel.to }, userEvent: 'delete.selection' });
      v.dispatch({ ...insertBlock(v.state, table), userEvent: 'input.paste' });
      return true;
    }
    if (!config.pasteRichText) return false;
    let rich: Conversion | null = null;
    try {
      rich = markdownForPaste(data.getData('text/html'), Array.from(data.types));
    } catch (err) {
      report(`Could not convert the pasted content: ${String(err)}`);
    }
    if (!rich) return false;
    event.preventDefault();
    v.dispatch(pasteMarkdown(v.state, rich.markdown, rich.block));
    return true;
  },
  dragover(event) {
    const types = event.dataTransfer?.types ?? [];
    if (types.includes('Files') || types.includes('text/uri-list') || types.includes('application/vnd.code.uri-list')) event.preventDefault();
    return false;
  },
  drop(event, v) {
    const data = event.dataTransfer;
    if (!data) return false;
    const pos = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? v.state.selection.main.head;
    const images = Array.from(data.files).filter((f) => f.type.startsWith('image/') || isImagePath(f.name));
    if (images.length) {
      event.preventDefault();
      void insertImageFiles(images, pos);
      return true;
    }
    const list = data.getData('application/vnd.code.uri-list') || data.getData('text/uri-list');
    const uris = list.split(/\r?\n/).filter((u) => u && !u.startsWith('#'));
    if (!uris.length) return false;
    event.preventDefault();
    void host
      .request<{ items: LinkedFile[] }>('resolveUris', { uris })
      .then(({ items }) => {
        const spec = insertPaths(items, Math.min(pos, v.state.doc.length))(v.state);
        if (spec) v.dispatch(spec);
      })
      .catch((err) => report(`Could not link the dropped file: ${String(err)}`));
    return true;
  },
});

let statsTimer: ReturnType<typeof setTimeout> | undefined;
let stateTimer: ReturnType<typeof setTimeout> | undefined;

function sendStats(): void {
  if (!view) return;
  const state = view.state;
  const text = state.doc.toString();
  const sel = state.selection.main;
  host.post({
    type: 'stats',
    words: countWords(text),
    chars: text.length,
    selWords: sel.empty ? 0 : countWords(state.doc.sliceString(sel.from, sel.to)),
  });
}

function saveState(): void {
  if (!view) return;
  const sel = view.state.selection.main;
  host.setState({ anchor: sel.anchor, head: sel.head, scrollPos: view.scrollDOM.scrollTop });
}

function onUpdate(update: ViewUpdate): void {
  for (const tr of update.transactions) {
    if (tr.annotation(externalChange)) continue;
    if (tr.docChanged) sync?.localChange(tr);
    else if (tr.selection && !tr.annotation(cursorFix) && tr.isUserEvent('select')) sync?.flush();
  }
  const mode = update.state.field(modeField);
  if (update.startState.field(modeField) !== mode) {
    toolbar?.setMode(mode);
    host.post({ type: 'modeChanged', mode });
  }
  if (update.docChanged || update.selectionSet) {
    toolbar?.setHeading(headingLevelAt(update.state));
    clearTimeout(statsTimer);
    statsTimer = setTimeout(sendStats, 300);
    clearTimeout(stateTimer);
    stateTimer = setTimeout(saveState, 300);
  }
}

/* ---------- start-up ---------- */

function createEditor(message: Extract<HostMessage, { type: 'init' }>): void {
  isMac = message.isMac;
  testSession = message.test === true;
  resolveUrl = makeResolver(message.baseUri, message.rootUri);
  config = message.config;
  wikiLinks = !!message.config.wikiLinks;
  applyConfig(message.config);

  toolbar = createToolbar(runCommand, isMac);
  toolbar.setMode(message.mode);
  toolbar.setVisible(config.showToolbar);
  const editorHost = document.createElement('div');
  editorHost.className = 'mdl-editor';
  app.replaceChildren(toolbar.dom, editorHost);

  const saved = host.getState();
  const length = message.text.length;
  const clamp = (n: number | undefined) => Math.max(0, Math.min(length, n ?? 0));

  const extensions: Extension[] = [
    modeField.init(() => message.mode),
    renderCompartment.of(renderConfig.of(currentRenderConfig())),
    hostActions.of({ openLink, openWikiLink, pickImages }),
    languageCompartment.of(language()),
    syntaxHighlighting(classHighlighter),
    syntaxHighlighting(markdownHighlighter),
    EditorView.lineWrapping,
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of((e) => e.altKey),
    indentUnit.of('  '),
    EditorState.tabSize.of(4),
    drawSelection(),
    dropCursor(),
    codeFolding({ placeholderText: '⋯' }),
    keymap.of([
      { key: 'Mod-Alt-[', run: foldCode },
      { key: 'Mod-Alt-]', run: unfoldCode },
    ]),
    closeBrackets(),
    blockField,
    inlinePlugin,
    editGuard,
    editingBehaviour(),
    popoverField,
    links.extension,
    // VS Code owns undo for the document; only the standalone page keeps its own history.
    host.standalone ? [history(), keymap.of(historyKeymap)] : [],
    search({ top: true }),
    completions(host, runCommand, () => wikiLinks),
    keymap.of([
      ...KEYS.map(({ key, id }) => ({
        key,
        preventDefault: true,
        run: () => {
          if (host.standalone) runCommand(id);
          return true;
        },
      })),
      ...searchKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    domHandlers,
    EditorView.updateListener.of(onUpdate),
    EditorView.editorAttributes.compute([modeField], (state) => ({ class: `mdl-mode-${state.field(modeField)}` })),
    EditorView.contentAttributes.compute([renderConfig], (state) => ({
      'aria-label': 'Markdown document',
      spellcheck: String(state.facet(renderConfig).spellCheck),
    })),
    nonce ? EditorView.cspNonce.of(nonce) : [],
  ];

  const state = EditorState.create({
    doc: message.text,
    selection: EditorSelection.single(clamp(saved.anchor), clamp(saved.head)),
    extensions,
  });
  sync = new SyncClient(state, (epoch, changes) => host.post({ type: 'edit', epoch, changes }));
  sync.epoch = message.epoch;
  view = new EditorView({ state, parent: editorHost });
  toolbar.setHeading(headingLevelAt(state));

  if (saved.scrollPos) requestAnimationFrame(() => view && (view.scrollDOM.scrollTop = saved.scrollPos!));
  view.scrollDOM.addEventListener('scroll', () => {
    clearTimeout(stateTimer);
    stateTimer = setTimeout(saveState, 300);
  });
  // The fixed-width font may finish loading after the first measurement.
  void document.fonts?.ready.then(() => applyConfig(config));
  sendStats();
  if (document.hasFocus()) view.focus();
}

host.onMessage((message) => {
  switch (message.type) {
    case 'init':
      if (view && sync) {
        // The host restarted the session: adopt its text without rebuilding the editor.
        sync.applySync(view, message.text, message.epoch);
        applyConfig(message.config);
      } else {
        createEditor(message);
      }
      break;
    case 'patch':
      if (view && sync) sync.applyPatch(view, message.from, message.to, message.insert, message.epoch, message.reason);
      break;
    case 'sync':
      if (view && sync) sync.applySync(view, message.text, message.epoch);
      break;
    case 'config':
      applyConfig(message.config);
      break;
    case 'command':
      runCommand(message.id, message.arg);
      break;
    case 'flush':
      sync?.flush();
      host.post({ type: 'flushed', reqId: message.reqId });
      break;
    case 'debugRequest':
      host.post({
        type: 'debugState',
        reqId: message.reqId,
        text: view?.state.doc.toString() ?? '',
        mode: view?.state.field(modeField) ?? 'raw',
        epoch: sync?.epoch ?? -1,
        cursorLine: view ? view.state.doc.lineAt(view.state.selection.main.head).number - 1 : 0,
        problems: [...problems],
        rendered: {
          diagrams: document.querySelectorAll('.cm-md-mermaid[data-state="done"] svg').length,
          diagramErrors: document.querySelectorAll('.cm-md-mermaid[data-state="error"]').length,
          math: document.querySelectorAll('.cm-md-math .katex').length,
          wikiLinks: document.querySelectorAll('.cm-md-wikilink').length,
        },
        brokenLinks: view ? brokenLinkMessages(view.state) : [],
      });
      break;
    case 'debugType':
      if (view && testSession) {
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, insert: message.text }, selection: { anchor: at + message.text.length }, userEvent: 'input.type' });
      }
      break;
    case 'selectionRequest': {
      const sel = view?.state.selection.main;
      host.post({ type: 'selectionState', reqId: message.reqId, text: view && sel && !sel.empty ? view.state.doc.sliceString(sel.from, sel.to) : '' });
      break;
    }
  }
});

const reportFocus = () => host.post({ type: 'focus', focused: document.hasFocus() });
window.addEventListener('focus', reportFocus);
window.addEventListener('blur', () => {
  // Hand over anything still unsent before another part of VS Code takes over.
  sync?.flush();
  reportFocus();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sync?.flush();
});

host.post({ type: 'ready' });
reportFocus();

// For the browser harness and automated checks.
(window as unknown as { __mdl?: unknown }).__mdl = {
  get view() {
    return view;
  },
  runCommand,
  flush: () => sync?.flush(),
};
