// Broken link checking on the extension host: looks at the file system for the webview,
// and publishes the same findings as diagnostics with a quick fix for mistyped anchors.
// Only local files are looked at; nothing is ever fetched from the network.
import * as vscode from 'vscode';
import {
  analyse,
  type Anchors,
  checkAnchor,
  type DocumentScan,
  type Finding,
  lineStarts,
  type LinkIssue,
  MARKDOWN_FILE,
  positionIn,
  scanText,
  type Target,
  withIssues,
} from '../shared/linkCheck';
import { toLF } from '../shared/textUtil';

export const DIAGNOSTIC_SOURCE = 'Seamless Markdown';

/** How long a look at the file system is trusted when no watcher covers the file. */
const CACHE_MS = 5000;
const EDIT_DELAY_MS = 400;
const FILES_DELAY_MS = 300;
const MAX_TARGETS = 5000;
const MAX_ANCHOR_FILE_BYTES = 5 * 1024 * 1024;
/** Larger documents are not parsed again on the extension host; the editor still underlines their links. */
const MAX_DOCUMENT_CHARS = 5_000_000;

interface FileInfo {
  exists: boolean;
  /** Anchors of a Markdown file, read on first use. */
  anchors?: Promise<Anchors | null>;
}

interface Published {
  version: number;
  entries: { diagnostic: vscode.Diagnostic; finding: Finding }[];
}

function enabled(uri: vscode.Uri): boolean {
  return vscode.workspace.getConfiguration('seamlessMarkdown', uri).get<boolean>('checkLinks', true);
}

function isMarkdown(document: vscode.TextDocument): boolean {
  return document.languageId === 'markdown' || MARKDOWN_FILE.test(document.uri.path);
}

function dirOf(uri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(uri, '..');
}

/** Where a link path leads: from the document's folder, or from the workspace folder when it starts with "/". */
export function resolveLinkPath(document: vscode.Uri, path: string): vscode.Uri {
  const docDir = dirOf(document);
  if (!path.startsWith('/')) return vscode.Uri.joinPath(docDir, path);
  return vscode.Uri.joinPath(vscode.workspace.getWorkspaceFolder(document)?.uri ?? docDir, path);
}

export class LinkChecker implements vscode.Disposable {
  readonly collection = vscode.languages.createDiagnosticCollection(DIAGNOSTIC_SOURCE);
  private readonly disposables: vscode.Disposable[] = [this.collection];
  private readonly files = new Map<string, { at: number; info: Promise<FileInfo> }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly published = new Map<string, Published>();
  /** Heading slugs of each open document, to notice when links from other files are affected. */
  private readonly signatures = new Map<string, string>();
  /** Watchers for the folders of documents that are outside every workspace folder. */
  private readonly folderWatchers = new Map<string, vscode.Disposable>();
  private workspaceWatcher: vscode.Disposable | undefined;
  private filesTimer: ReturnType<typeof setTimeout> | undefined;
  /** Documents that were opened in this editor; they stay checked until they close, wherever they are. */
  private readonly adopted = new Set<string>();
  private readonly openAnchors = new WeakMap<vscode.TextDocument, { version: number; anchors: Anchors }>();

  /** @param recheck asks the open editors to check their links again. */
  constructor(private readonly recheck: () => void) {
    const workspace = vscode.workspace;
    this.disposables.push(
      workspace.onDidCreateFiles(() => this.filesChanged()),
      workspace.onDidDeleteFiles(() => this.filesChanged()),
      workspace.onDidRenameFiles(() => this.filesChanged()),
      workspace.onDidChangeWorkspaceFolders(() => this.filesChanged()),
      workspace.onDidOpenTextDocument((document) => {
        if (!this.checked(document)) return;
        this.watchFolders();
        this.schedule(document, 0);
      }),
      workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length) this.schedule(e.document, EDIT_DELAY_MS);
      }),
      workspace.onDidCloseTextDocument((document) => this.closed(document)),
      workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('seamlessMarkdown.checkLinks')) return;
        this.watchFolders();
        this.refreshAll();
      }),
      vscode.languages.registerCodeActionsProvider(
        { language: 'markdown' },
        { provideCodeActions: (document, range) => this.codeActions(document, range) },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
    );
    this.watchFolders();
    this.refreshAll();
  }

  /* ---------- the file system ---------- */

  private info(uri: vscode.Uri): Promise<FileInfo> {
    const key = uri.toString();
    const cached = this.files.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.info;
    const info = Promise.resolve(vscode.workspace.fs.stat(uri)).then(
      (): FileInfo => ({ exists: true }),
      (): FileInfo => ({ exists: false }),
    );
    if (this.files.size > 20000) this.files.clear();
    this.files.set(key, { at: Date.now(), info });
    return info;
  }

  private async anchors(uri: vscode.Uri, info: FileInfo): Promise<Anchors | null> {
    // An open document counts as it is on screen, saved or not.
    const key = uri.toString();
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (open) {
      const known = this.openAnchors.get(open);
      if (known?.version === open.version) return known.anchors;
      const anchors = scanText(toLF(open.getText()));
      this.openAnchors.set(open, { version: open.version, anchors });
      return anchors;
    }
    info.anchors ??= Promise.resolve(vscode.workspace.fs.readFile(uri)).then(
      (bytes) => (bytes.byteLength > MAX_ANCHOR_FILE_BYTES ? null : scanText(toLF(new TextDecoder('utf-8').decode(bytes)))),
      () => null,
    );
    return info.anchors;
  }

  private async checkOne(document: vscode.Uri, target: Target): Promise<LinkIssue | null> {
    if (typeof target.path !== 'string' || target.path === '' || document.scheme === 'untitled') return null;
    let uri: vscode.Uri;
    try {
      uri = resolveLinkPath(document, target.path);
    } catch {
      return { reason: 'file' };
    }
    const info = await this.info(uri);
    if (!info.exists) return { reason: 'file' };
    if (!target.anchor || !MARKDOWN_FILE.test(uri.path)) return null;
    const anchors = await this.anchors(uri, info);
    // A file that cannot be read as text is not reported: it exists, which is all that is known.
    return anchors ? checkAnchor(anchors, target.anchor) : null;
  }

  /** For each target, what is wrong with it, or null when it exists. */
  check(document: vscode.Uri, targets: readonly Target[]): Promise<(LinkIssue | null)[]> {
    return Promise.all(targets.slice(0, MAX_TARGETS).map((target) => this.checkOne(document, target).catch(() => null)));
  }

  /** Files were created, deleted, renamed or saved: forget what was seen and look again. */
  private filesChanged(uri?: vscode.Uri): void {
    if (this.filesTimer !== undefined) return;
    if (uri && !this.concerns(uri)) return;
    this.filesTimer = setTimeout(() => {
      this.filesTimer = undefined;
      // Entries go stale rather than away: their keys say which files the links care about.
      for (const entry of this.files.values()) entry.at = 0;
      this.refreshAll();
      this.recheck();
    }, FILES_DELAY_MS);
  }

  /**
   * True when a link asked about this file or something inside this folder. Everything
   * else that happens in the workspace (build output, node_modules, .git) costs one look here.
   */
  private concerns(uri: vscode.Uri): boolean {
    const key = uri.toString();
    if (this.files.has(key)) return true;
    const prefix = key.endsWith('/') ? key : key + '/';
    for (const known of this.files.keys()) if (known.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Whether this document gets diagnostics: a Markdown file that is open in this editor
   * (or was, until it closes), or one inside a workspace folder and not under node_modules.
   * A file from somewhere else that merely passes through the text editor is left alone.
   */
  private checked(document: vscode.TextDocument): boolean {
    if (!isMarkdown(document) || !enabled(document.uri)) return false;
    // A buffer that was never saved has no folder for its links to start from.
    if (document.uri.scheme === 'untitled') return false;
    if (this.adopted.has(document.uri.toString())) return true;
    return !!vscode.workspace.getWorkspaceFolder(document.uri) && !/\/node_modules\//.test(document.uri.path);
  }

  /** Called when a document is opened in this editor. */
  adopt(document: vscode.TextDocument): void {
    this.adopted.add(document.uri.toString());
    this.watchFolders();
    this.schedule(document, 0);
  }

  /** Watches only while something is being checked, so nothing runs when the setting is off. */
  private watchFolders(): void {
    const wanted = new Map<string, vscode.Uri>();
    let any = false;
    for (const document of vscode.workspace.textDocuments) {
      if (!this.checked(document)) continue;
      any = true;
      if (document.uri.scheme !== 'file' || vscode.workspace.getWorkspaceFolder(document.uri)) continue;
      const dir = dirOf(document.uri);
      wanted.set(dir.toString(), dir);
    }
    if (any && !this.workspaceWatcher) {
      const watcher = vscode.workspace.createFileSystemWatcher('**/*');
      this.workspaceWatcher = vscode.Disposable.from(
        watcher,
        watcher.onDidCreate((uri) => this.filesChanged(uri)),
        watcher.onDidDelete((uri) => this.filesChanged(uri)),
        // A saved Markdown file may have gained or lost headings.
        watcher.onDidChange((uri) => this.filesChanged(uri)),
      );
    } else if (!any && this.workspaceWatcher) {
      this.workspaceWatcher.dispose();
      this.workspaceWatcher = undefined;
    }
    for (const [key, watcher] of this.folderWatchers) {
      if (wanted.has(key)) continue;
      watcher.dispose();
      this.folderWatchers.delete(key);
    }
    for (const [key, dir] of wanted) {
      if (this.folderWatchers.has(key)) continue;
      // Not recursive: watching a whole tree outside the workspace could be very large.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, '*'));
      const events = [
        watcher.onDidCreate((uri) => this.filesChanged(uri)),
        watcher.onDidDelete((uri) => this.filesChanged(uri)),
        watcher.onDidChange((uri) => this.filesChanged(uri)),
      ];
      this.folderWatchers.set(key, vscode.Disposable.from(watcher, ...events));
    }
  }

  /* ---------- diagnostics ---------- */

  private schedule(document: vscode.TextDocument, delay: number): void {
    const key = document.uri.toString();
    if (!this.checked(document)) {
      // Switched off, or not ours: make sure nothing stays behind.
      if (this.published.has(key)) this.clear(document.uri);
      return;
    }
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refresh(document);
      }, delay),
    );
  }

  private refreshAll(): void {
    for (const document of vscode.workspace.textDocuments) this.schedule(document, 0);
  }

  private clear(uri: vscode.Uri): void {
    this.collection.delete(uri);
    this.published.delete(uri.toString());
  }

  private closed(document: vscode.TextDocument): void {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.signatures.delete(key);
    this.adopted.delete(key);
    this.clear(document.uri);
    this.watchFolders();
  }

  /** The findings of a document as it is right now. */
  async findings(document: vscode.TextDocument): Promise<{ findings: Finding[]; scan: DocumentScan; text: string }> {
    const text = toLF(document.getText());
    const scan = scanText(text);
    const analysis = analyse(scan);
    return { findings: withIssues(analysis, await this.check(document.uri, analysis.targets)), scan, text };
  }

  private async refresh(document: vscode.TextDocument): Promise<void> {
    if (document.isClosed) return;
    const key = document.uri.toString();
    if (!this.checked(document) || document.getText().length > MAX_DOCUMENT_CHARS) {
      this.clear(document.uri);
      return;
    }
    const version = document.version;
    let result: Awaited<ReturnType<LinkChecker['findings']>>;
    try {
      result = await this.findings(document);
    } catch {
      return;
    }
    // A newer edit has its own refresh on the way.
    if (document.isClosed || document.version !== version) return;
    const starts = lineStarts(result.text);
    const position = (offset: number) => {
      const p = positionIn(starts, offset);
      return new vscode.Position(p.line, p.ch);
    };
    const entries = result.findings.map((finding) => {
      const diagnostic = new vscode.Diagnostic(new vscode.Range(position(finding.from), position(finding.to)), finding.message, vscode.DiagnosticSeverity.Warning);
      diagnostic.source = DIAGNOSTIC_SOURCE;
      diagnostic.code = `link-${finding.reason}`;
      return { diagnostic, finding };
    });
    this.published.set(key, { version, entries });
    this.collection.set(
      document.uri,
      entries.map((e) => e.diagnostic),
    );

    // Links in other files may point at the headings of this one.
    const signature = [...result.scan.headings.map((h) => h.slug), ...result.scan.htmlIds, ...result.scan.lineSlugs].join('\n');
    const before = this.signatures.get(key);
    this.signatures.set(key, signature);
    if (before !== undefined && before !== signature) {
      for (const other of vscode.workspace.textDocuments) if (other !== document) this.schedule(other, 0);
      this.recheck();
    }
  }

  private codeActions(document: vscode.TextDocument, range: vscode.Range): vscode.CodeAction[] {
    const published = this.published.get(document.uri.toString());
    if (!published || published.version !== document.version) return [];
    const starts = lineStarts(toLF(document.getText()));
    const out: vscode.CodeAction[] = [];
    for (const { diagnostic, finding } of published.entries) {
      const fix = finding.fix;
      if (!fix || !diagnostic.range.intersection(range)) continue;
      const from = positionIn(starts, fix.from);
      const to = positionIn(starts, fix.to);
      const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
      action.diagnostics = [diagnostic];
      action.isPreferred = true;
      action.edit = new vscode.WorkspaceEdit();
      action.edit.replace(document.uri, new vscode.Range(from.line, from.ch, to.line, to.ch), fix.insert);
      out.push(action);
    }
    return out;
  }

  dispose(): void {
    clearTimeout(this.filesTimer);
    this.workspaceWatcher?.dispose();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.folderWatchers.values()) watcher.dispose();
    this.folderWatchers.clear();
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
