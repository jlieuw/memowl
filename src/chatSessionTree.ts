import * as vscode from 'vscode';
import {
  ChatSession,
  ChatWorkspace,
  getChatWorkspaces,
  listChatSessions,
  listRecentSessions,
} from './chatSessionStore';
import { escapeMarkdown } from './markdown';

/** How the root of the view is organised. Persisted across windows. */
export type ChatGroupMode = 'workspace' | 'recency';

const MODE_KEY = 'memowl.chatGroupMode';

/** Upper bound on the flat recency list, to keep the scan bounded. */
const RECENT_LIMIT = 200;

export interface ChatWorkspaceNode {
  kind: 'chatWorkspace';
  workspace: ChatWorkspace;
}

export interface ChatSessionNode {
  kind: 'chatSession';
  workspace: ChatWorkspace;
  session: ChatSession;
}

export interface ChatBucketNode {
  kind: 'chatBucket';
  id: string;
  label: string;
  expanded: boolean;
  children: ChatSessionNode[];
}

export type ChatNode = ChatWorkspaceNode | ChatSessionNode | ChatBucketNode;

export class ChatSessionTreeProvider
  implements vscode.TreeDataProvider<ChatNode>
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    ChatNode | undefined
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private mode: ChatGroupMode;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.mode = context.globalState.get<ChatGroupMode>(MODE_KEY) ?? 'workspace';
    void this.publishMode();
  }

  async setGroupMode(mode: ChatGroupMode): Promise<void> {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    await this.context.globalState.update(MODE_KEY, mode);
    await this.publishMode();
    this.refresh();
  }

  /** Mirrors the mode into a context key so the title bar can show the right toggle. */
  private publishMode(): Thenable<unknown> {
    return vscode.commands.executeCommand('setContext', MODE_KEY, this.mode);
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(node: ChatNode): vscode.TreeItem {
    switch (node.kind) {
      case 'chatWorkspace':
        return this.buildWorkspaceItem(node.workspace);
      case 'chatBucket':
        return buildBucketItem(node);
      default:
        return this.buildSessionItem(node);
    }
  }

  async getChildren(node?: ChatNode): Promise<ChatNode[]> {
    if (!node) {
      return this.mode === 'recency'
        ? this.buildBuckets()
        : this.buildWorkspaces();
    }
    if (node.kind === 'chatBucket') {
      return node.children;
    }
    if (node.kind !== 'chatWorkspace') {
      return [];
    }
    // Sessions are parsed lazily, so only the expanded workspace pays the cost.
    const sessions = await listChatSessions(node.workspace.fsPath);
    return sessions.map((session) => ({
      kind: 'chatSession',
      workspace: node.workspace,
      session,
    }));
  }

  private async buildWorkspaces(): Promise<ChatNode[]> {
    const workspaces = await getChatWorkspaces(this.context);
    return workspaces.map((workspace) => ({
      kind: 'chatWorkspace',
      workspace,
    }));
  }

  private async buildBuckets(): Promise<ChatNode[]> {
    const recent = await listRecentSessions(this.context, RECENT_LIMIT);

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = midnight.getTime();
    const day = 86_400_000;

    const ranges = [
      { label: 'Today', from: today },
      { label: 'Yesterday', from: today - day },
      { label: 'Previous 7 days', from: today - 7 * day },
      { label: 'Previous 30 days', from: today - 30 * day },
      { label: 'Older', from: Number.NEGATIVE_INFINITY },
    ];

    const buckets: ChatBucketNode[] = ranges.map((range) => ({
      kind: 'chatBucket',
      id: `chatbucket:${range.label}`,
      label: range.label,
      expanded: false,
      children: [],
    }));

    for (const { session, workspace } of recent) {
      const index = ranges.findIndex((r) => session.modifiedAt >= r.from);
      buckets[index].children.push({ kind: 'chatSession', workspace, session });
    }

    const filled = buckets.filter((bucket) => bucket.children.length > 0);
    if (filled.length) {
      filled[0].expanded = true;
    }
    return filled;
  }

  private buildWorkspaceItem(workspace: ChatWorkspace): vscode.TreeItem {
    const item = new vscode.TreeItem(
      workspace.label,
      workspace.isCurrent
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.contextValue = workspace.isCurrent
      ? 'chatWorkspaceCurrent'
      : 'chatWorkspaceOther';
    item.iconPath = new vscode.ThemeIcon(
      workspace.isCurrent ? 'star-full' : 'folder-library'
    );
    item.description = workspace.lastUsed
      ? relativeTime(workspace.lastUsed)
      : 'no chats';

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escapeMarkdown(workspace.label)}**\n\n`);
    tooltip.appendMarkdown(
      `Workspace hash: ${escapeMarkdown(workspace.hash)}\n\n`
    );
    if (workspace.target) {
      tooltip.appendCodeblock(workspace.target.fsPath);
    }
    item.tooltip = tooltip;

    return item;
  }

  private buildSessionItem(node: ChatSessionNode): vscode.TreeItem {
    const { session, workspace } = node;
    const item = new vscode.TreeItem(
      session.title,
      vscode.TreeItemCollapsibleState.None
    );
    item.contextValue = 'chatSession';
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.description =
      this.mode === 'recency'
        ? `${workspace.label} · ${relativeTime(session.modifiedAt)}`
        : relativeTime(session.modifiedAt);

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escapeMarkdown(session.title)}**\n\n`);
    tooltip.appendMarkdown(
      `Last used: ${new Date(session.modifiedAt).toLocaleString()}\n\n`
    );
    if (session.createdAt) {
      tooltip.appendMarkdown(
        `Created: ${new Date(session.createdAt).toLocaleString()}\n\n`
      );
    }
    if (session.requestCount) {
      tooltip.appendMarkdown(`Requests: ${session.requestCount}+\n\n`);
    }
    if (!workspace.isCurrent) {
      tooltip.appendMarkdown(
        `Belongs to **${escapeMarkdown(
          workspace.label
        )}** — opening it switches window.\n\n`
      );
    }
    tooltip.appendCodeblock(session.fsPath);
    item.tooltip = tooltip;

    item.command = {
      command: 'memowl.openChatSession',
      title: 'Resume Chat',
      arguments: [node],
    };

    return item;
  }
}

function buildBucketItem(node: ChatBucketNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.label,
    node.expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
  );
  item.id = node.id;
  item.contextValue = 'chatBucket';
  item.description = `${node.children.length}`;
  return item;
}

function relativeTime(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 30) {
    return `${days}d ago`;
  }
  return new Date(ms).toLocaleDateString();
}
