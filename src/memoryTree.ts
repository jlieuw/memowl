import * as path from 'path';
import * as vscode from 'vscode';
import { getMemoryRoots, listDir, MemoryRoot } from './memoryStore';

/** A node representing one of the discovered memory storage roots. */
export interface RootNode {
  kind: 'root';
  root: MemoryRoot;
}

/** A node representing a file or folder inside a memory store. */
export interface EntryNode {
  kind: 'entry';
  root: MemoryRoot;
  uri: vscode.Uri;
  name: string;
  isDirectory: boolean;
}

export type MemoryNode = RootNode | EntryNode;

/** Human-readable hints for the well-known scope subfolders. */
const SCOPE_HINTS: Record<string, string> = {
  repo: 'repository scope',
  session: 'session scope',
};

export class MemoryTreeProvider
  implements vscode.TreeDataProvider<MemoryNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    MemoryNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: MemoryNode): vscode.TreeItem {
    if (node.kind === 'root') {
      return this.buildRootItem(node.root);
    }
    return this.buildEntryItem(node);
  }

  async getChildren(node?: MemoryNode): Promise<MemoryNode[]> {
    if (!node) {
      const roots = await getMemoryRoots(this.context);
      return roots.map((root) => ({ kind: 'root', root }));
    }

    const dirPath = node.kind === 'root' ? node.root.fsPath : node.uri.fsPath;
    const entries = await listDir(dirPath);
    return entries.map((e) => ({
      kind: 'entry',
      root: node.root,
      uri: e.uri,
      name: e.name,
      isDirectory: e.isDirectory,
    }));
  }

  private buildRootItem(root: MemoryRoot): vscode.TreeItem {
    const item = new vscode.TreeItem(
      root.label,
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.contextValue = 'memoryRoot';
    item.iconPath = new vscode.ThemeIcon(
      root.kind === 'global' ? 'account' : root.isCurrent ? 'star-full' : 'folder-library'
    );

    if (root.kind === 'global') {
      item.description = 'shared across all workspaces';
    } else {
      const names = root.workspaceNames?.length
        ? root.workspaceNames.join(', ')
        : undefined;
      const shortHash = root.hash ? root.hash.slice(0, 8) : '';
      item.description = names
        ? `${names}  ·  ${shortHash}`
        : shortHash;
    }

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${root.label}**\n\n`);
    if (root.kind === 'workspace' && root.hash) {
      tooltip.appendMarkdown(`Workspace hash: \`${root.hash}\`\n\n`);
      if (root.workspaceNames?.length) {
        tooltip.appendMarkdown(
          `Maps to: ${root.workspaceNames.map((n) => `\`${n}\``).join(', ')}\n\n`
        );
      }
    }
    tooltip.appendMarkdown(`\`${root.fsPath}\``);
    item.tooltip = tooltip;

    return item;
  }

  private buildEntryItem(node: EntryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.name,
      node.isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    item.resourceUri = node.uri;
    item.tooltip = node.uri.fsPath;

    if (node.isDirectory) {
      item.contextValue = 'memoryFolder';
      item.iconPath = vscode.ThemeIcon.Folder;
      // Annotate the well-known scope folders when directly under a workspace root.
      const hint = SCOPE_HINTS[node.name.toLowerCase()];
      if (hint && this.isTopLevel(node)) {
        item.description = hint;
      }
    } else {
      item.contextValue = 'memoryFile';
      item.iconPath = vscode.ThemeIcon.File;
      item.command = {
        command: 'memowl.openMemory',
        title: 'Open Memory',
        arguments: [node],
      };
    }

    return item;
  }

  /** True when the entry sits directly inside its root's memories directory. */
  private isTopLevel(node: EntryNode): boolean {
    return path.dirname(node.uri.fsPath) === node.root.fsPath;
  }
}
