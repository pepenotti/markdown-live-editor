// VS Code's own Outline view does not work for custom editors, so the headings of the
// active document are offered as a small tree in the Explorer.
import * as vscode from 'vscode';
import { buildOutline, extractHeadings, type OutlineNode } from '../shared/textUtil';
import type { MarkdownEditorProvider } from './markdownEditorProvider';

export class OutlineProvider implements vscode.TreeDataProvider<OutlineNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private roots: OutlineNode[] = [];
  private lastText: string | undefined;

  constructor(private readonly provider: MarkdownEditorProvider) {
    provider.onDidChange(() => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.refresh(), 250);
    });
  }

  private refresh(): void {
    const text = this.provider.active?.document.getText();
    if (text === this.lastText) return;
    this.lastText = text;
    this.roots = text === undefined ? [] : buildOutline(extractHeadings(text));
    this.changed.fire();
  }

  getChildren(node?: OutlineNode): OutlineNode[] {
    if (!node && this.lastText === undefined) this.refresh();
    return node ? node.children : this.roots;
  }

  getTreeItem(node: OutlineNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.text,
      node.children.length ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `H${node.level}`;
    item.command = { command: 'seamlessMarkdown.revealLine', title: 'Go to heading', arguments: [node.line] };
    return item;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
  }
}
