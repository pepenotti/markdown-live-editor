import * as vscode from 'vscode';
import { type CommandId, type HostMessage, type Mode, MODE_LABELS, MODES, VIEW_TYPE, type WebviewMessage } from '../shared/protocol';
import { buildOutline, extractHeadings } from '../shared/textUtil';
import { exportHtml, exportPdf, removeTempFiles, wikiHrefs } from './export';
import { isNotePath } from '../shared/wikiLinks';
import { BacklinksProvider } from './backlinks';
import { listFiles, resolveUris, saveImage } from './images';
import { MarkdownEditorProvider, type Session } from './markdownEditorProvider';
import { OutlineProvider } from './outline';
import { renderer, rendererLoaded } from './renderer';
import { insertTocInTextEditor, updateToc, updateTocOnSave } from './toc';

/** Command name (after "seamlessMarkdown.") → what the webview is asked to do. */
const EDITOR_COMMANDS: Record<string, [CommandId, unknown?]> = {
  toggleBold: ['bold'],
  toggleItalic: ['italic'],
  toggleStrikethrough: ['strike'],
  toggleInlineCode: ['code'],
  insertLink: ['link'],
  insertImage: ['image'],
  insertTable: ['table'],
  insertCodeBlock: ['codeBlock'],
  insertRule: ['rule'],
  toggleBulletList: ['bulletList'],
  toggleNumberedList: ['orderedList'],
  toggleTaskList: ['taskList'],
  toggleTask: ['toggleTask'],
  toggleQuote: ['quote'],
  headingIncrease: ['headingUp'],
  headingDecrease: ['headingDown'],
  heading1: ['heading', 1],
  heading2: ['heading', 2],
  heading3: ['heading', 3],
  find: ['find'],
  cycleMode: ['cycleMode'],
  rawMode: ['setMode', 'raw'],
  halfPreviewMode: ['setMode', 'half'],
  fullPreviewMode: ['setMode', 'full'],
};

function activeMarkdownUri(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === 'markdown') return editor.document.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return undefined;
}

export function activate(context: vscode.ExtensionContext): unknown {
  const provider = new MarkdownEditorProvider(context);
  const register = (name: string, run: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`seamlessMarkdown.${name}`, run));

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
  );

  for (const [name, [id, arg]] of Object.entries(EDITOR_COMMANDS)) {
    register(name, () => provider.active?.send(id, arg));
  }

  /** Closes the other tab of the same file in the active group, so switching editors replaces in place. */
  const closeOther = async (uri: vscode.Uri, isOther: (input: unknown) => boolean) => {
    const key = uri.toString();
    const tabs = vscode.window.tabGroups.activeTabGroup.tabs.filter((tab) => {
      const input = tab.input;
      return isOther(input) && (input as { uri: vscode.Uri }).uri.toString() === key;
    });
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  };

  register('openWith', async (uri?: vscode.Uri) => {
    const target = uri ?? activeMarkdownUri();
    if (!target) {
      void vscode.window.showInformationMessage('Open a Markdown file first.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    await closeOther(target, (input) => input instanceof vscode.TabInputText);
  });

  register('openSource', async () => {
    const session = provider.active;
    if (!session) return;
    const uri = session.document.uri;
    await session.flush();
    await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    await closeOther(uri, (input) => input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE);
  });

  // VS Code owns the undo history of the document. Typing is sent in short bursts, so
  // anything still unsent has to arrive before undo, redo or save runs.
  const afterFlush = (command: string) => async () => {
    try {
      await provider.active?.flush();
    } finally {
      await vscode.commands.executeCommand(command);
    }
  };
  register('undo', afterFlush('undo'));
  register('redo', afterFlush('redo'));
  register('save', afterFlush('workbench.action.files.save'));

  register('pickMode', async () => {
    const session = provider.active;
    if (!session) return;
    const items = MODES.map((mode) => ({ label: MODE_LABELS[mode], description: mode === session.mode ? 'current' : '', mode }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Editor mode' });
    if (pick) session.send('setMode', pick.mode);
  });

  register('goToHeading', async () => {
    const session = provider.active;
    if (!session) return;
    await session.flush();
    const headings = extractHeadings(session.document.getText());
    if (!headings.length) {
      void vscode.window.showInformationMessage('This document has no headings.');
      return;
    }
    const items = headings.map((h) => ({ label: `${'    '.repeat(h.level - 1)}${h.text}`, description: `H${h.level}`, line: h.line }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Go to heading',
      onDidSelectItem: (item) => session.send('revealLine', (item as (typeof items)[number]).line),
    });
    if (pick) session.send('revealLine', pick.line);
    session.send('focus');
  });

  register('revealLine', (line: number) => {
    const session = provider.active;
    if (!session || typeof line !== 'number') return;
    session.send('revealLine', line);
  });

  const outline = new OutlineProvider(provider);
  context.subscriptions.push(outline, vscode.window.registerTreeDataProvider('seamlessMarkdown.outline', outline));

  const backlinks = new BacklinksProvider(provider);
  context.subscriptions.push(backlinks, vscode.window.registerTreeDataProvider('seamlessMarkdown.backlinks', backlinks));
  register('openBacklink', (uri: unknown, line: unknown) => {
    if (uri instanceof vscode.Uri && isNotePath(uri.path)) return provider.openAtLine(uri, typeof line === 'number' ? line : 0);
    return undefined;
  });

  register('copyAsHtml', async () => {
    const session = provider.active;
    if (!session) return;
    await session.flush();
    const selected = await session.selectedText();
    const text = selected || session.document.getText();
    // A copied fragment has no folder, so with wiki links on a note is copied as its text.
    const { html } = renderer().renderMarkdown(text, { wikiLinks: await wikiHrefs(session.document, text, provider.notes, false) });
    await vscode.env.clipboard.writeText(html);
    vscode.window.setStatusBarMessage(selected ? 'Copied the selection as HTML' : 'Copied the document as HTML', 3000);
  });

  const exporting = (what: string, run: (session: Session) => Promise<unknown>) => async () => {
    const session = provider.active;
    if (!session) return undefined;
    await session.flush();
    try {
      return await run(session);
    } catch (err) {
      void vscode.window.showErrorMessage(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };
  // A target passed as an argument skips the save dialog (used by the tests and by other extensions).
  register('exportHtml', (target?: unknown) =>
    exporting('The HTML export', (session) => exportHtml(session.document, target instanceof vscode.Uri ? target : undefined, provider.notes))(),
  );
  register('exportPdf', exporting('The PDF export', (session) => exportPdf(session.document, { notes: provider.notes })));
  context.subscriptions.push({ dispose: removeTempFiles });

  /* ---------- table of contents ---------- */
  // Both commands also work in the plain text editor.
  const markdownTextEditor = () => {
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document.languageId === 'markdown' ? editor : undefined;
  };
  register('insertTableOfContents', async () => {
    const session = provider.active;
    if (session) return session.send('toc');
    const editor = markdownTextEditor();
    if (editor) await insertTocInTextEditor(editor);
  });
  register('updateTableOfContents', async () => {
    const session = provider.active;
    const document = session?.document ?? markdownTextEditor()?.document;
    if (!document) return;
    await session?.flush();
    const result = await updateToc(document);
    if (result === 'missing') {
      void vscode.window.showInformationMessage('This document has no table of contents. Add one with "Seamless Markdown: Insert Table of Contents".');
    } else if (result === 'unchanged') {
      vscode.window.setStatusBarMessage('The table of contents is up to date', 3000);
    } else if (result === 'refused') {
      void vscode.window.showWarningMessage('The table of contents could not be updated: the document cannot be edited.');
    }
  });
  context.subscriptions.push(updateTocOnSave(provider));

  register('setAsDefault', async () => {
    await provider.setDefault(true);
    void vscode.window.showInformationMessage('Markdown files now open with Seamless Markdown.');
  });
  register('unsetAsDefault', async () => {
    await provider.setDefault(false);
    void vscode.window.showInformationMessage('Markdown files open with the standard text editor again.');
  });

  /* ---------- status bar ---------- */
  const modeItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  modeItem.command = 'seamlessMarkdown.pickMode';
  modeItem.name = 'Seamless Markdown: Mode';
  const countItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  countItem.name = 'Seamless Markdown: Word Count';
  context.subscriptions.push(modeItem, countItem);

  const refresh = () => {
    const session = provider.active;
    if (!session) {
      modeItem.hide();
      countItem.hide();
      return;
    }
    modeItem.text = `$(markdown) ${MODE_LABELS[session.mode]}`;
    modeItem.tooltip = 'Seamless Markdown mode. Click to change.';
    modeItem.show();
    const { words, chars, selWords } = session.stats;
    const minutes = Math.max(1, Math.round(words / 230));
    countItem.text = selWords ? `${selWords} of ${words} words` : `${words} words · ${minutes} min read`;
    countItem.tooltip = `${words} words, ${chars} characters`;
    countItem.show();
  };
  context.subscriptions.push(provider.onDidChange(refresh));
  refresh();

  if (context.extensionMode !== vscode.ExtensionMode.Test) return undefined;

  // Hooks for the integration tests.
  const only = async (uri: vscode.Uri): Promise<Session> => {
    for (let i = 0; i < 100; i++) {
      const session = provider.sessionsFor(uri)[0];
      if (session) {
        await session.whenReady();
        return session;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`No Seamless Markdown editor is open for ${uri.toString()}`);
  };
  return {
    sessionCount: (uri: vscode.Uri) => provider.sessionsFor(uri).length,
    whenReady: async (uri: vscode.Uri) => void (await only(uri)),
    post: async (uri: vscode.Uri, message: HostMessage) => (await only(uri)).post(message),
    command: async (uri: vscode.Uri, id: CommandId, arg?: unknown) => (await only(uri)).send(id, arg),
    flush: async (uri: vscode.Uri) => (await only(uri)).flush(),
    state: async (uri: vscode.Uri) => (await only(uri)).debugState(),
    states: async (uri: vscode.Uri) => Promise.all(provider.sessionsFor(uri).map((s) => s.debugState())),
    mode: async (uri: vscode.Uri): Promise<Mode> => (await only(uri)).mode,
    rendererLoaded: () => rendererLoaded(),
    // The PDF export on a machine without a browser that can print; returns what would have been opened.
    exportPdfWithoutBrowser: async (uri: vscode.Uri) => {
      const session = await only(uri);
      await session.flush();
      const opened: string[] = [];
      const file = await exportPdf(session.document, { browser: null, open: async (target) => void opened.push(target.fsPath), notes: provider.notes });
      return { file, opened };
    },
    outline: async (uri: vscode.Uri) => buildOutline(extractHeadings((await only(uri)).document.getText())),
    openLink: async (uri: vscode.Uri, href: string) => provider.openLink(await only(uri), href),
    saveImage: async (uri: vscode.Uri, name: string, base64: string) => saveImage((await only(uri)).document, name, base64),
    listFiles: async (uri: vscode.Uri, imagesOnly: boolean) => listFiles((await only(uri)).document, imagesOnly),
    resolveUris: async (uri: vscode.Uri, uris: string[]) => resolveUris((await only(uri)).document, uris),
    checkLinks: async (uri: vscode.Uri, targets: { path: string; anchor: string; wiki?: boolean }[]) => provider.links.check(uri, targets),
    listNotes: async (uri: vscode.Uri) => provider.notes.list(uri),
    noteHeadings: async (uri: vscode.Uri, name: string) => provider.notes.headings(uri, name),
    backlinks: async (uri: vscode.Uri) => (await provider.notes.backlinks(uri)).map((link) => ({ path: link.uri.fsPath, lines: link.lines })),
    /** What the Backlinks view shows right now, as file names. */
    backlinksView: async () => (await backlinks.getChildren()).map((node) => (node.kind === 'file' ? node.link.uri.fsPath : '')),
    resolveNote: async (uri: vscode.Uri, name: string) => {
      const found = await provider.notes.resolve(uri, name);
      return found.status === 'found' ? found.uri.fsPath : found.status;
    },
    /** Creates a note as a link would, without asking; the path of the file that is there afterwards. */
    createNote: async (uri: vscode.Uri, name: string) => {
      const location = provider.notes.locationFor(uri, name);
      return location && (await provider.notes.create(location)) ? location.fsPath : undefined;
    },
    /** What the index of notes holds and which folders are watched, to show that nothing runs while wiki links are off. */
    noteIndexState: async () => ({ ...provider.notes.state, watching: provider.watch.watching }),
    openWikiLink: async (uri: vscode.Uri, target: string, heading: string, create: boolean) =>
      provider.openWikiLink(await only(uri), target, heading, async () => create),
    openBacklink: async (uri: vscode.Uri, line: number) => provider.openAtLine(uri, line),
  } satisfies Record<string, (uri: vscode.Uri, ...rest: any[]) => unknown>;
}

export function deactivate(): void {}

export type { WebviewMessage };
