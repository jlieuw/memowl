import * as path from 'path';
import * as vscode from 'vscode';
import {
  createMemoryFile,
  deletePath,
  getMemoryRoots,
  MemoryRoot,
} from './memoryStore';
import { EntryNode, MemoryNode, MemoryTreeProvider } from './memoryTree';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MemoryTreeProvider(context);
  const treeView = vscode.window.createTreeView('memowl.memories', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

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
  void setupWatchers(context, provider).then((disposables) =>
    context.subscriptions.push(...disposables)
  );

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
}

export function deactivate(): void {
  // no-op
}

// --- helpers ---------------------------------------------------------------

/**
 * Watches each memory store for file changes and refreshes the tree.
 *
 * The stores live outside the workspace (global/workspace storage), so we use a
 * RelativePattern anchored on each root's absolute path — this is what lets
 * VS Code watch a directory that isn't part of the open workspace. Refreshes
 * are debounced because a single memory write can emit several fs events.
 */
async function setupWatchers(
  context: vscode.ExtensionContext,
  provider: MemoryTreeProvider
): Promise<vscode.Disposable[]> {
  const roots = await getMemoryRoots(context);
  const disposables: vscode.Disposable[] = [];

  let timer: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => provider.refresh(), 300);
  };

  for (const root of roots) {
    const pattern = new vscode.RelativePattern(
      vscode.Uri.file(root.fsPath),
      '**/*'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);
    disposables.push(watcher);
  }

  disposables.push({
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
    },
  });
  return disposables;
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
