import * as path from 'path';
import * as vscode from 'vscode';
import {
  createMemoryFile,
  deletePath,
  getMemoryRoots,
  locateWorkspaceStorage,
  MemoryRoot,
} from './memoryStore';
import { EntryNode, MemoryNode, MemoryTreeProvider } from './memoryTree';
import { chatSessionUri, getChatWorkspaces } from './chatSessionStore';
import { ChatNode, ChatSessionTreeProvider } from './chatSessionTree';

/**
 * Handoff slot for resuming a chat that lives in another workspace: the source window
 * records it here, the window that opens that workspace picks it up on activation.
 */
const PENDING_CHAT_KEY = 'memowl.pendingChatSession';
const PENDING_CHAT_TTL_MS = 5 * 60_000;

interface PendingChatSession {
  hash: string;
  sessionId: string;
  expiresAt: number;
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MemoryTreeProvider(context);
  const treeView = vscode.window.createTreeView('memowl.memories', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  const chatProvider = new ChatSessionTreeProvider(context);
  const chatView = vscode.window.createTreeView('memowl.chatSessions', {
    treeDataProvider: chatProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(chatView);

  // Auto-refresh: Copilot writes memories in the background, so keep the tree
  // in sync with the store on disk instead of relying on a manual refresh.
  treeView.onDidChangeVisibility(
    (e) => {
      if (e.visible) {
        provider.refresh();
      }
    },
    undefined,
    context.subscriptions
  );
  chatView.onDidChangeVisibility(
    (e) => {
      if (e.visible) {
        chatProvider.refresh();
      }
    },
    undefined,
    context.subscriptions
  );
  void setupWatchers(context, provider, chatProvider).then((disposables) =>
    context.subscriptions.push(...disposables)
  );

  void resumePendingChatSession(context);

  const register = (command: string, callback: (...args: any[]) => any) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback)
    );

  register('memowl.refresh', () => provider.refresh());

  register('memowl.openMemory', async (node?: MemoryNode) => {
    const target = asEntry(node);
    if (!target || target.isDirectory) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(target.uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('memowl.copyPath', async (node?: MemoryNode) => {
    const fsPath = pathOf(node);
    if (!fsPath) {
      return;
    }
    await vscode.env.clipboard.writeText(fsPath);
    vscode.window.setStatusBarMessage('Memowl: path copied', 2000);
  });

  register('memowl.revealInOS', async (node?: MemoryNode) => {
    const fsPath = pathOf(node);
    if (!fsPath) {
      return;
    }
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(fsPath)
    );
  });

  register('memowl.openStorageFolder', async (node?: MemoryNode) => {
    if (!node || node.kind !== 'root') {
      return;
    }
    // The memories dir may not exist yet; reveal the nearest existing ancestor.
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(node.root.fsPath)
    );
  });

  register('memowl.deleteMemory', async (node?: MemoryNode) => {
    const target = asEntry(node);
    if (!target) {
      return;
    }
    const what = target.isDirectory ? 'folder (and its contents)' : 'memory';
    const choice = await vscode.window.showWarningMessage(
      `Delete ${what} "${target.name}"? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (choice !== 'Delete') {
      return;
    }
    try {
      await deletePath(target.uri.fsPath, target.isDirectory);
      provider.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(
        `Memowl: could not delete "${target.name}": ${errText(err)}`
      );
    }
  });

  register('memowl.newMemoryHere', (node?: MemoryNode) =>
    createFlow(context, provider, node)
  );
  register('memowl.newMemory', () => createFlow(context, provider));

  register('memowl.refreshChatSessions', () => chatProvider.refresh());
  register('memowl.groupChatsByRecency', () =>
    chatProvider.setGroupMode('recency')
  );
  register('memowl.groupChatsByWorkspace', () =>
    chatProvider.setGroupMode('workspace')
  );

  register('memowl.openChatSession', async (node?: ChatNode) => {
    if (!node || node.kind !== 'chatSession') {
      return;
    }
    const { workspace, session } = node;
    if (workspace.isCurrent) {
      await openChatSessionHere(session.sessionId);
      return;
    }

    // A chat log only resolves against the workspace storage of its own window,
    // so resuming one from elsewhere means reopening that workspace first.
    if (!workspace.target) {
      vscode.window.showWarningMessage(
        `Memowl: this chat belongs to workspace ${workspace.hash.slice(
          0,
          8
        )}, which no longer maps to a folder on disk.`
      );
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      `"${session.title}" belongs to "${workspace.label}". Chats can only be resumed in their own window.`,
      { modal: true },
      'Open Workspace and Resume'
    );
    if (choice !== 'Open Workspace and Resume') {
      return;
    }

    const pending: PendingChatSession = {
      hash: workspace.hash,
      sessionId: session.sessionId,
      expiresAt: Date.now() + PENDING_CHAT_TTL_MS,
    };
    await context.globalState.update(PENDING_CHAT_KEY, pending);
    await vscode.commands.executeCommand('vscode.openFolder', workspace.target, {
      forceNewWindow: true,
    });
  });

  register('memowl.openChatWorkspace', async (node?: ChatNode) => {
    if (!node || node.kind !== 'chatWorkspace' || !node.workspace.target) {
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      node.workspace.target,
      { forceNewWindow: true }
    );
  });

  register('memowl.openChatSessionLog', async (node?: ChatNode) => {
    if (!node || node.kind !== 'chatSession') {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(
      vscode.Uri.file(node.session.fsPath)
    );
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  register('memowl.copyChatSessionPath', async (node?: ChatNode) => {
    const fsPath = chatPathOf(node);
    if (!fsPath) {
      return;
    }
    await vscode.env.clipboard.writeText(fsPath);
    vscode.window.setStatusBarMessage('Memowl: path copied', 2000);
  });

  register('memowl.revealChatSessionInOS', async (node?: ChatNode) => {
    const fsPath = chatPathOf(node);
    if (!fsPath) {
      return;
    }
    await vscode.commands.executeCommand(
      'revealFileInOS',
      vscode.Uri.file(fsPath)
    );
  });
}

export function deactivate(): void {
  // no-op
}

// --- helpers ---------------------------------------------------------------

/**
 * Watches each memory store and the current workspace's chat log for file changes,
 * and refreshes the corresponding tree.
 *
 * The stores live outside the workspace (global/workspace storage), so we use a
 * RelativePattern anchored on each root's absolute path — this is what lets
 * VS Code watch a directory that isn't part of the open workspace. Refreshes
 * are debounced because a single memory write can emit several fs events.
 */
async function setupWatchers(
  context: vscode.ExtensionContext,
  provider: MemoryTreeProvider,
  chatProvider: ChatSessionTreeProvider
): Promise<vscode.Disposable[]> {
  const disposables: vscode.Disposable[] = [];

  const debounced = (refresh: () => void) => {
    let timer: NodeJS.Timeout | undefined;
    disposables.push({
      dispose: () => {
        if (timer) {
          clearTimeout(timer);
        }
      },
    });
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(refresh, 300);
    };
  };

  const watch = (dir: string, onChange: () => void) => {
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), '**/*');
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(onChange);
    watcher.onDidChange(onChange);
    watcher.onDidDelete(onChange);
    disposables.push(watcher);
  };

  const refreshMemories = debounced(() => provider.refresh());
  for (const root of await getMemoryRoots(context)) {
    watch(root.fsPath, refreshMemories);
  }

  // Only the current workspace's chat log is written by this window; other
  // workspaces are refreshed when their node is expanded or on demand.
  const refreshChats = debounced(() => chatProvider.refresh());
  const current = (await getChatWorkspaces(context)).find((w) => w.isCurrent);
  if (current) {
    watch(current.fsPath, refreshChats);
  }

  return disposables;
}

/** Opens a chat session that belongs to the workspace of this window. */
async function openChatSessionHere(sessionId: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(
      'vscode.open',
      chatSessionUri(sessionId)
    );
  } catch (err) {
    vscode.window.showErrorMessage(
      `Memowl: could not open the chat session — your VS Code version may not support resuming chats by URI. ${errText(
        err
      )}`
    );
  }
}

/**
 * Completes a resume that was started in another window: if this window opened the
 * workspace the chat belongs to, open the chat and clear the handoff.
 */
async function resumePendingChatSession(
  context: vscode.ExtensionContext
): Promise<void> {
  const pending = context.globalState.get<PendingChatSession>(PENDING_CHAT_KEY);
  if (!pending) {
    return;
  }
  if (Date.now() > pending.expiresAt) {
    await context.globalState.update(PENDING_CHAT_KEY, undefined);
    return;
  }

  const { currentHash } = await locateWorkspaceStorage(context);
  if (currentHash !== pending.hash) {
    return;
  }

  await context.globalState.update(PENDING_CHAT_KEY, undefined);
  await openChatSessionHere(pending.sessionId);
}

function chatPathOf(node?: ChatNode): string | undefined {
  switch (node?.kind) {
    case 'chatSession':
      return node.session.fsPath;
    case 'chatWorkspace':
      return node.workspace.fsPath;
    default:
      return undefined;
  }
}

function asEntry(node?: MemoryNode): EntryNode | undefined {
  return node && node.kind === 'entry' ? node : undefined;
}

function pathOf(node?: MemoryNode): string | undefined {
  if (!node) {
    return undefined;
  }
  return node.kind === 'root' ? node.root.fsPath : node.uri.fsPath;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Determines the target directory for a new memory:
 *   - invoked on a folder  -> that folder
 *   - invoked on a root     -> the root's memories dir
 *   - invoked from title bar -> ask which root, then use its memories dir
 */
async function createFlow(
  context: vscode.ExtensionContext,
  provider: MemoryTreeProvider,
  node?: MemoryNode
): Promise<void> {
  let baseDir: string | undefined;

  if (node?.kind === 'entry' && node.isDirectory) {
    baseDir = node.uri.fsPath;
  } else if (node?.kind === 'root') {
    baseDir = node.root.fsPath;
  } else {
    baseDir = await pickRootDir(context);
  }

  if (!baseDir) {
    return;
  }

  const relPath = await vscode.window.showInputBox({
    prompt: 'New memory file (you can include subfolders, e.g. repo/notes.md)',
    value: 'notes.md',
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) {
        return 'Please enter a file name.';
      }
      if (path.isAbsolute(trimmed) || trimmed.includes('..')) {
        return 'Use a relative path without "..".';
      }
      return undefined;
    },
  });
  if (!relPath) {
    return;
  }

  let fileName = relPath.trim();
  if (!path.extname(fileName)) {
    fileName += '.md';
  }
  const target = path.join(baseDir, fileName);
  const title = path.basename(fileName, path.extname(fileName));
  const template = `# ${title}\n\n- \n`;

  try {
    await createMemoryFile(target, template);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      vscode.window.showWarningMessage(
        `Memowl: "${fileName}" already exists.`
      );
    } else {
      vscode.window.showErrorMessage(
        `Memowl: could not create "${fileName}": ${errText(err)}`
      );
    }
    return;
  }

  provider.refresh();
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  await vscode.window.showTextDocument(doc);
}

async function pickRootDir(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  const roots = await getMemoryRoots(context);
  const items = roots.map((root) => ({
    label: root.label,
    description: rootDescription(root),
    root,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Create memory in which store?',
    placeHolder: 'Select a memory scope',
  });
  return picked?.root.fsPath;
}

function rootDescription(root: MemoryRoot): string {
  if (root.kind === 'global') {
    return 'shared across all workspaces';
  }
  if (root.isCurrent) {
    return 'this workspace';
  }
  return root.workspaceNames?.join(', ') ?? root.hash ?? '';
}
