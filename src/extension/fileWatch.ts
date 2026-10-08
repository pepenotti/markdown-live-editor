// One set of file system watchers for everything that wants to know about files: the link
// checker and the index of notes. Each says what it needs; a folder is watched once however
// many ask, and not at all when nobody does.
import * as vscode from 'vscode';

export interface FileEvent {
  uri: vscode.Uri;
  kind: 'create' | 'delete' | 'change';
}

interface Wish {
  workspace: boolean;
  folders: Map<string, vscode.Uri>;
}

export class FileWatch implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<FileEvent>();
  /** Fires for every watched file. Listeners pick out what concerns them. */
  readonly onDidChange = this.emitter.event;
  private readonly wishes = new Map<object, Wish>();
  private workspaceWatcher: vscode.Disposable | undefined;
  /** Watchers for single folders outside every workspace folder. */
  private readonly folderWatchers = new Map<string, vscode.Disposable>();

  /**
   * States what `user` needs watched from now on, replacing what it asked for before:
   * every file of the workspace, and the files directly inside some other folders.
   */
  want(user: object, workspace: boolean, folders: Iterable<vscode.Uri> = []): void {
    const wanted = new Map<string, vscode.Uri>();
    for (const dir of folders) wanted.set(dir.toString(), dir);
    if (workspace || wanted.size) this.wishes.set(user, { workspace, folders: wanted });
    else this.wishes.delete(user);
    this.apply();
  }

  /** What is being watched right now (for the tests). */
  get watching(): { workspace: boolean; folders: string[] } {
    return { workspace: !!this.workspaceWatcher, folders: [...this.folderWatchers.keys()].sort() };
  }

  private watch(pattern: vscode.GlobPattern): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    return vscode.Disposable.from(
      watcher,
      watcher.onDidCreate((uri) => this.emitter.fire({ uri, kind: 'create' })),
      watcher.onDidDelete((uri) => this.emitter.fire({ uri, kind: 'delete' })),
      // A saved Markdown file may have gained or lost headings and links.
      watcher.onDidChange((uri) => this.emitter.fire({ uri, kind: 'change' })),
    );
  }

  private apply(): void {
    let workspace = false;
    const folders = new Map<string, vscode.Uri>();
    for (const wish of this.wishes.values()) {
      workspace ||= wish.workspace;
      for (const [key, dir] of wish.folders) folders.set(key, dir);
    }
    if (workspace && !this.workspaceWatcher) {
      this.workspaceWatcher = this.watch('**/*');
    } else if (!workspace && this.workspaceWatcher) {
      this.workspaceWatcher.dispose();
      this.workspaceWatcher = undefined;
    }
    for (const [key, watcher] of this.folderWatchers) {
      if (folders.has(key)) continue;
      watcher.dispose();
      this.folderWatchers.delete(key);
    }
    for (const [key, dir] of folders) {
      // Not recursive: watching a whole tree outside the workspace could be very large.
      if (!this.folderWatchers.has(key)) this.folderWatchers.set(key, this.watch(new vscode.RelativePattern(dir, '*')));
    }
  }

  dispose(): void {
    this.wishes.clear();
    this.apply();
    this.emitter.dispose();
  }
}
