// The Backlinks view in the Explorer: the notes that link to the active one, and the
// lines in them that do. Shown only while wiki links are turned on.
import * as vscode from 'vscode';
import type { MarkdownEditorProvider } from './markdownEditorProvider';
import { type Backlink, wikiLinksEnabled } from './notes';

type Node = { kind: 'file'; link: Backlink } | { kind: 'line'; uri: vscode.Uri; line: number; text: string };

export class BacklinksProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private shown: string | undefined;

  constructor(private readonly provider: MarkdownEditorProvider) {
    this.disposables.push(
      // Fires for focus and word counts as well; only another note is a reason to look again.
      provider.onDidChange(() => {
        if (provider.active?.document.uri.toString() !== this.shown) this.refreshSoon();
      }),
      provider.notes.onDidChange(() => this.refreshSoon()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('seamlessMarkdown.wikiLinks')) this.refreshSoon();
      }),
    );
  }

  private refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), 250);
  }

  // VS Code asks only while the view is visible, so a hidden view never reads a file.
  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return node.kind === 'file' ? node.link.lines.map((l) => ({ kind: 'line', uri: node.link.uri, ...l })) : [];
    const uri = this.provider.active?.document.uri;
    this.shown = uri?.toString();
    if (!uri || !wikiLinksEnabled(uri)) return [];
    return (await this.provider.notes.backlinks(uri)).map((link) => ({ kind: 'file', link }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'file') {
      const item = new vscode.TreeItem(node.link.uri, vscode.TreeItemCollapsibleState.Expanded);
      item.description = vscode.workspace.asRelativePath(vscode.Uri.joinPath(node.link.uri, '..'), false);
      item.iconPath = vscode.ThemeIcon.File;
      item.command = { command: 'seamlessMarkdown.openBacklink', title: 'Open note', arguments: [node.link.uri, node.link.lines[0]?.line ?? 0] };
      return item;
    }
    const item = new vscode.TreeItem(node.text || '(empty line)', vscode.TreeItemCollapsibleState.None);
    item.description = `line ${node.line + 1}`;
    item.tooltip = node.text;
    item.command = { command: 'seamlessMarkdown.openBacklink', title: 'Open at this line', arguments: [node.uri, node.line] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
