// The custom text editor: one Session per open editor tab.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  type CommandId,
  type EditorConfig,
  type HostMessage,
  type ListFilesPayload,
  type Mode,
  MODES,
  type ResolveUrisPayload,
  type SaveImagePayload,
  type TextChange,
  VIEW_TYPE,
  type WebviewMessage,
} from '../shared/protocol';
import { DocumentSync, type SyncTarget } from './documentSync';
import { listFiles, pickImages, resolveUris, saveImage } from './images';

export interface Stats {
  words: number;
  chars: number;
  selWords: number;
}

type DebugState = Extract<WebviewMessage, { type: 'debugState' }>;

function readConfig(resource: vscode.Uri): EditorConfig {
  const c = vscode.workspace.getConfiguration('seamlessMarkdown', resource);
  const mode = c.get<string>('defaultMode', 'half');
  return {
    defaultMode: (MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'half',
    lineWidth: Math.max(0, c.get<number>('lineWidth', 860)),
    fontSize: Math.min(40, Math.max(8, c.get<number>('fontSize', 15))),
    fontFamily: c.get<string>('fontFamily', ''),
    showToolbar: c.get<boolean>('showToolbar', true),
    tableAutoAlign: c.get<boolean>('tableAutoAlign', true),
    customCss: c.get<string>('customCss', ''),
    spellCheck: c.get<boolean>('spellCheck', false),
  };
}

export class Session implements SyncTarget {
  readonly sync: DocumentSync;
  mode: Mode;
  stats: Stats = { words: 0, chars: 0, selWords: 0 };
  focused = false;
  ready = false;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly waiters = new Map<number, (value: unknown) => void>();
  private readonly readyWaiters: (() => void)[] = [];
  private nextId = 1;
  private pendingAnchor: string | undefined;

  constructor(
    private readonly provider: MarkdownEditorProvider,
    readonly document: vscode.TextDocument,
    readonly panel: vscode.WebviewPanel,
  ) {
    this.sync = new DocumentSync(this);
    this.mode = provider.initialMode(document);
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    webview.html = this.html();

    this.disposables.push(
      webview.onDidReceiveMessage((message: WebviewMessage) => this.onMessage(message)),
      panel.onDidChangeViewState(() => {
        if (panel.visible) this.sync.becameVisible();
        if (!panel.active) this.focused = false;
        provider.sessionChanged();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document !== document) return;
        const reason =
          e.reason === vscode.TextDocumentChangeReason.Undo ? 'undo' : e.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : undefined;
        this.sync.documentChanged(reason);
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('seamlessMarkdown', document.uri)) this.post({ type: 'config', config: readConfig(document.uri) });
      }),
    );
  }

  /* ---------- SyncTarget ---------- */

  getText(): string {
    return this.document.getText();
  }

  applyChanges(changes: readonly TextChange[]): Thenable<boolean> {
    const eol = this.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    for (const c of changes) {
      const text = eol === '\n' ? c.insert : c.insert.replace(/\n/g, eol);
      edit.replace(this.document.uri, new vscode.Range(c.fromLine, c.fromCh, c.toLine, c.toCh), text);
    }
    return vscode.workspace.applyEdit(edit);
  }

  post(message: HostMessage): void {
    void this.panel.webview.postMessage(message);
  }

  isVisible(): boolean {
    return this.panel.visible;
  }

  log(message: string): void {
    this.provider.log(`[${vscode.workspace.asRelativePath(this.document.uri)}] ${message}`);
  }

  /* ---------- messages ---------- */

  send(id: CommandId, arg?: unknown): void {
    this.post({ type: 'command', id, arg });
  }

  private onMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'ready': {
        const { text, epoch } = this.sync.start();
        const folder = vscode.workspace.getWorkspaceFolder(this.document.uri);
        const webview = this.panel.webview;
        this.post({
          type: 'init',
          text,
          epoch,
          mode: this.mode,
          config: readConfig(this.document.uri),
          baseUri: webview.asWebviewUri(vscode.Uri.joinPath(this.document.uri, '..')).toString(),
          rootUri: folder ? webview.asWebviewUri(folder.uri).toString() : null,
          isMac: process.platform === 'darwin',
        });
        this.ready = true;
        for (const done of this.readyWaiters.splice(0)) done();
        if (this.pendingAnchor) this.send('revealAnchor', this.pendingAnchor);
        this.pendingAnchor = undefined;
        break;
      }
      case 'edit':
        void this.sync.receiveEdit(message.epoch, message.changes);
        break;
      case 'flushed':
      case 'debugState':
      case 'selectionState':
        this.waiters.get(message.reqId)?.(message);
        this.waiters.delete(message.reqId);
        break;
      case 'focus':
        this.focused = message.focused;
        this.provider.sessionChanged();
        break;
      case 'modeChanged':
        this.mode = message.mode;
        this.provider.rememberMode(this.document, message.mode);
        this.provider.sessionChanged();
        break;
      case 'stats':
        this.stats = { words: message.words, chars: message.chars, selWords: message.selWords };
        this.provider.sessionChanged();
        break;
      case 'openLink':
        void this.provider.openLink(this, message.href);
        break;
      case 'request':
        void this.onRequest(message.reqId, message.kind, message.payload);
        break;
      case 'log':
        this.log(`webview ${message.level}: ${message.message}`);
        break;
    }
  }

  private async onRequest(reqId: number, kind: string, payload: unknown): Promise<void> {
    try {
      let data: unknown;
      switch (kind) {
        case 'saveImage': {
          const p = payload as SaveImagePayload;
          data = await saveImage(this.document, String(p.name ?? ''), String(p.base64 ?? ''));
          break;
        }
        case 'listFiles':
          data = { files: await listFiles(this.document, !!(payload as ListFilesPayload)?.imagesOnly) };
          break;
        case 'pickImage':
          data = { items: await pickImages(this.document) };
          break;
        case 'resolveUris': {
          const uris = (payload as ResolveUrisPayload)?.uris;
          data = { items: await resolveUris(this.document, Array.isArray(uris) ? uris.map(String) : []) };
          break;
        }
        default:
          throw new Error(`Unknown request: ${kind}`);
      }
      this.post({ type: 'response', reqId, ok: true, data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: 'response', reqId, ok: false, error: message });
      void vscode.window.showWarningMessage(`Seamless Markdown: ${message}`);
    }
  }

  private ask<T>(message: (reqId: number) => HostMessage, timeoutMs: number): Promise<T | undefined> {
    const reqId = this.nextId++;
    return new Promise<T | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(reqId);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.set(reqId, (value) => {
        clearTimeout(timer);
        resolve(value as T);
      });
      this.post(message(reqId));
    });
  }

  /** Makes sure everything typed so far has reached the document. */
  async flush(): Promise<void> {
    if (this.ready && this.panel.visible) await this.ask((reqId) => ({ type: 'flush', reqId }), 400);
    await this.sync.drain();
  }

  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  debugState(): Promise<DebugState | undefined> {
    return this.ask<DebugState>((reqId) => ({ type: 'debugRequest', reqId }), 3000);
  }

  /** The Markdown the user has selected, or an empty string. */
  async selectedText(): Promise<string> {
    if (!this.ready) return '';
    const reply = await this.ask<{ text: string }>((reqId) => ({ type: 'selectionRequest', reqId }), 1000);
    return reply?.text ?? '';
  }

  revealAnchor(anchor: string): void {
    if (this.ready) this.send('revealAnchor', anchor);
    else this.pendingAnchor = anchor;
  }

  /* ---------- set-up ---------- */

  private resourceRoots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.provider.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.document.uri, '..')];
    // Workspace folders let "../images/x.png" and "/images/x.png" resolve inside the project.
    if (vscode.workspace.getWorkspaceFolder(this.document.uri)) {
      for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri);
    }
    return roots;
  }

  private html(): string {
    const webview = this.panel.webview;
    const dist = vscode.Uri.joinPath(this.provider.context.extensionUri, 'dist');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css'));
    const nonce = randomBytes(18).toString('base64');
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data: blob:`,
      // KaTeX and Mermaid put style attributes on what they draw. Scripts stay nonce-only,
      // and document content is never inserted as HTML.
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="mdl-nonce" content="${nonce}">
<link rel="stylesheet" href="${style}">
<title>Seamless Markdown</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    for (const resolve of this.waiters.values()) resolve(undefined);
    this.waiters.clear();
  }
}

export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly sessions = new Set<Session>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the active session, its mode, focus or statistics change. */
  readonly onDidChange = this.changed.event;
  private readonly channel = vscode.window.createOutputChannel('Seamless Markdown');

  constructor(readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(this.changed, this.channel);
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const session = new Session(this, document, panel);
    this.sessions.add(session);
    panel.onDidDispose(() => {
      this.sessions.delete(session);
      session.dispose();
      this.sessionChanged();
    });
    this.sessionChanged();
    void this.offerDefault();
  }

  log(message: string): void {
    this.channel.appendLine(message);
  }

  /** The session of the editor tab that is active in the window. */
  get active(): Session | undefined {
    for (const s of this.sessions) if (s.panel.active) return s;
    return undefined;
  }

  sessionsFor(uri: vscode.Uri): Session[] {
    const key = uri.toString();
    return [...this.sessions].filter((s) => s.document.uri.toString() === key);
  }

  sessionChanged(): void {
    const active = this.active;
    void vscode.commands.executeCommand('setContext', 'seamlessMarkdown.focus', !!active?.focused);
    this.changed.fire();
  }

  /* ---------- modes ---------- */

  private modeKey(document: vscode.TextDocument): string {
    return `mode:${document.uri.toString()}`;
  }

  initialMode(document: vscode.TextDocument): Mode {
    const config = vscode.workspace.getConfiguration('seamlessMarkdown', document.uri);
    const fallback = readConfig(document.uri).defaultMode;
    if (!config.get<boolean>('rememberModePerFile', true)) return fallback;
    const saved = this.context.workspaceState.get<string>(this.modeKey(document));
    return saved && (MODES as readonly string[]).includes(saved) ? (saved as Mode) : fallback;
  }

  rememberMode(document: vscode.TextDocument, mode: Mode): void {
    void this.context.workspaceState.update(this.modeKey(document), mode);
  }

  /* ---------- links ---------- */

  async openLink(session: Session, href: string): Promise<void> {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href)?.[1]?.toLowerCase();
    if (scheme) {
      // Only ordinary web and mail links leave the editor.
      if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
        await vscode.env.openExternal(vscode.Uri.parse(href, true));
      } else {
        void vscode.window.showWarningMessage(`Seamless Markdown does not open "${scheme}:" links.`);
      }
      return;
    }
    const hash = href.indexOf('#');
    const rawPath = hash >= 0 ? href.slice(0, hash) : href;
    const anchor = hash >= 0 ? href.slice(hash + 1) : '';
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      path = rawPath;
    }
    const docDir = vscode.Uri.joinPath(session.document.uri, '..');
    const folder = vscode.workspace.getWorkspaceFolder(session.document.uri);
    const target = path.startsWith('/') ? vscode.Uri.joinPath(folder?.uri ?? docDir, path) : vscode.Uri.joinPath(docDir, path);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(target);
    } catch {
      void vscode.window.showWarningMessage(`Linked file not found: ${path}`);
      return;
    }
    if (stat.type & vscode.FileType.Directory) {
      await vscode.commands.executeCommand('revealInExplorer', target);
    } else if (/\.(md|markdown|mdown|mkd)$/i.test(target.path)) {
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
      if (anchor) for (const s of this.sessionsFor(target)) s.revealAnchor(anchor);
    } else {
      await vscode.commands.executeCommand('vscode.open', target);
    }
  }

  /* ---------- default editor ---------- */

  isDefault(): boolean {
    const associations = vscode.workspace.getConfiguration('workbench').get<Record<string, string>>('editorAssociations') ?? {};
    return associations['*.md'] === VIEW_TYPE;
  }

  async setDefault(enable: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('workbench');
    const current = { ...(config.inspect<Record<string, string>>('editorAssociations')?.globalValue ?? {}) };
    if (enable) {
      current['*.md'] = VIEW_TYPE;
      current['*.markdown'] = VIEW_TYPE;
    } else {
      for (const key of Object.keys(current)) if (current[key] === VIEW_TYPE) delete current[key];
    }
    await config.update('editorAssociations', Object.keys(current).length ? current : undefined, vscode.ConfigurationTarget.Global);
  }

  private async offerDefault(): Promise<void> {
    const key = 'askedAboutDefault';
    if (this.context.extensionMode === vscode.ExtensionMode.Test) return;
    if (this.context.globalState.get<boolean>(key) || this.isDefault()) return;
    if (!vscode.workspace.getConfiguration('seamlessMarkdown').get<boolean>('promptToSetDefault', true)) return;
    await this.context.globalState.update(key, true);
    const yes = 'Use as default';
    const choice = await vscode.window.showInformationMessage(
      'Open Markdown files with Seamless Markdown by default? You can change this later with "Seamless Markdown: Stop Using as Default Editor".',
      yes,
      'Not now',
    );
    if (choice === yes) await this.setDefault(true);
  }
}
