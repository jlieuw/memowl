import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

/**
 * The VS Code extension id under which Copilot Chat stores its native agent memories.
 * Verified location:
 *   <User>/globalStorage/GitHub.copilot-chat/memory-tool/memories/            (user scope)
 *   <User>/workspaceStorage/<hash>/GitHub.copilot-chat/memory-tool/memories/  (repo + session scopes)
 */
const COPILOT_DIR = 'GitHub.copilot-chat';
const MEMORY_SUBPATH = path.join('memory-tool', 'memories');

export type MemoryRootKind = 'global' | 'workspace';

export interface MemoryRoot {
  /** Stable identifier for the tree. */
  id: string;
  /** Human-friendly label. */
  label: string;
  /** Absolute path to the `.../memory-tool/memories` directory (may not exist yet). */
  fsPath: string;
  kind: MemoryRootKind;
  /** True when this root belongs to the currently open workspace. */
  isCurrent: boolean;
  /** workspaceStorage hash, when kind === 'workspace'. */
  hash?: string;
  /** Friendly folder/workspace names this hash maps to. */
  workspaceNames?: string[];
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function basenameFromUriString(uriStr: string): string {
  try {
    const fsPath = vscode.Uri.parse(uriStr).fsPath.replace(/[\\/]+$/, '');
    return path.basename(fsPath) || uriStr;
  } catch {
    return uriStr;
  }
}

/**
 * Reads `workspace.json` inside a workspaceStorage hash directory and returns the
 * friendly folder / .code-workspace name(s) it maps to. This is what turns an opaque
 * hash like `6d567ab1...` into "uip.base" (or the workspace file name).
 */
async function readWorkspaceNames(hashDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(hashDir, 'workspace.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      folder?: string;
      workspace?: string;
    };
    if (parsed.folder) {
      return [basenameFromUriString(parsed.folder)];
    }
    if (parsed.workspace) {
      return [basenameFromUriString(parsed.workspace)];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Discovers all Copilot memory roots reachable from this machine's VS Code storage.
 *
 * We anchor on the extension's own storage URIs (which VS Code guarantees), then
 * navigate to the sibling Copilot storage directories:
 *   - globalStorageUri  -> .../User/globalStorage/<me>      -> .../globalStorage/GitHub.copilot-chat/...
 *   - storageUri        -> .../workspaceStorage/<hash>/<me> -> .../workspaceStorage/<hash>/GitHub.copilot-chat/...
 */
export async function getMemoryRoots(
  context: vscode.ExtensionContext
): Promise<MemoryRoot[]> {
  const roots: MemoryRoot[] = [];

  // --- User (global) scope -------------------------------------------------
  const globalStorageDir = path.dirname(context.globalStorageUri.fsPath); // .../User/globalStorage
  const globalMemDir = path.join(globalStorageDir, COPILOT_DIR, MEMORY_SUBPATH);
  roots.push({
    id: 'global',
    label: 'User (global)',
    fsPath: globalMemDir,
    kind: 'global',
    isCurrent: false,
  });

  // --- Workspace-scoped roots ---------------------------------------------
  let workspaceStorageDir: string | undefined;
  let currentHash: string | undefined;

  if (context.storageUri) {
    const hashDir = path.dirname(context.storageUri.fsPath); // .../workspaceStorage/<hash>
    currentHash = path.basename(hashDir);
    workspaceStorageDir = path.dirname(hashDir); // .../workspaceStorage
  } else {
    // No folder open: derive workspaceStorage as a sibling of globalStorage.
    const userDir = path.dirname(globalStorageDir); // .../User
    const candidate = path.join(userDir, 'workspaceStorage');
    if (await exists(candidate)) {
      workspaceStorageDir = candidate;
    }
  }

  if (workspaceStorageDir && (await exists(workspaceStorageDir))) {
    let entries: import('fs').Dirent[] = [];
    try {
      entries = await fs.readdir(workspaceStorageDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const hash = entry.name;
      const hashDir = path.join(workspaceStorageDir, hash);
      const memDir = path.join(hashDir, COPILOT_DIR, MEMORY_SUBPATH);
      const isCurrent = hash === currentHash;
      const hasMemories = await exists(memDir);

      // Always include the current workspace (so users can create the first memory);
      // include others only when they actually contain a memory store.
      if (!hasMemories && !isCurrent) {
        continue;
      }

      const names = await readWorkspaceNames(hashDir);
      const label = isCurrent
        ? 'This workspace'
        : names[0] ?? hash.slice(0, 8);

      roots.push({
        id: `ws:${hash}`,
        label,
        fsPath: memDir,
        kind: 'workspace',
        isCurrent,
        hash,
        workspaceNames: names,
      });
    }
  }

  // Order: global first, then current workspace, then the rest alphabetically.
  roots.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'global' ? -1 : 1;
    }
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    return a.label.localeCompare(b.label);
  });

  return roots;
}

export interface DirEntry {
  uri: vscode.Uri;
  name: string;
  isDirectory: boolean;
}

/** Lists the immediate children of a directory, folders first, then files (alpha). */
export async function listDir(dirPath: string): Promise<DirEntry[]> {
  let raw: import('fs').Dirent[];
  try {
    raw = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const result: DirEntry[] = raw
    .filter((e) => e.isDirectory() || e.isFile())
    .map((e) => ({
      uri: vscode.Uri.file(path.join(dirPath, e.name)),
      name: e.name,
      isDirectory: e.isDirectory(),
    }));

  result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return result;
}

/** Creates a memory file (and any parent folders), refusing to overwrite an existing file. */
export async function createMemoryFile(
  filePath: string,
  contents: string
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  // 'wx' fails if the file already exists.
  const handle = await fs.open(filePath, 'wx');
  try {
    await handle.writeFile(contents);
  } finally {
    await handle.close();
  }
}

/** Deletes a file or a directory (recursively). */
export async function deletePath(
  target: string,
  isDirectory: boolean
): Promise<void> {
  if (isDirectory) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.rm(target, { force: true });
  }
}
