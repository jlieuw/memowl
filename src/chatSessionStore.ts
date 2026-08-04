import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { locateWorkspaceStorage, readWorkspaceInfo } from './memoryStore';

/**
 * VS Code persists each Copilot chat conversation as an append-only JSONL log:
 *   <User>/workspaceStorage/<hash>/chatSessions/<sessionId>.jsonl
 * The session id is the file name, and it is what the chat editor resolves.
 */
const CHAT_SESSIONS_DIR = 'chatSessions';

/** URI scheme the workbench registers for local chat sessions. */
const CHAT_SESSION_SCHEME = 'vscode-chat-session';
const LOCAL_SESSION_AUTHORITY = 'local';

/**
 * Session logs can be several MB. Titles and the opening request are written near
 * the top, so we only read a prefix instead of parsing whole conversations.
 */
const HEAD_BYTES = 128 * 1024;

/** How many logs to parse per round when filling the recency list. */
const RECENT_BATCH = 64;

export interface ChatWorkspace {
  /** Stable identifier for the tree. */
  id: string;
  label: string;
  hash: string;
  /** Absolute path to the `chatSessions` directory. */
  fsPath: string;
  /** True when this is the workspace open in this window. */
  isCurrent: boolean;
  /** Timestamp of the most recently used chat, or undefined when there are none. */
  lastUsed?: number;
  /** The folder / `.code-workspace` to reopen, when recorded. */
  target?: vscode.Uri;
  isWorkspaceFile: boolean;
}

export interface ChatSession {
  sessionId: string;
  fsPath: string;
  title: string;
  /** Number of requests found in the parsed prefix (a lower bound). */
  requestCount: number;
  createdAt?: number;
  modifiedAt: number;
}

export interface RecentChatSession {
  session: ChatSession;
  workspace: ChatWorkspace;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the URI the workbench uses for a local chat session, so it can be handed to
 * the `vscode.open` command. Mirrors `LocalChatSessionUri.forSession` in VS Code:
 * `vscode-chat-session://local/<base64url(sessionId)>`.
 */
export function chatSessionUri(sessionId: string): vscode.Uri {
  const encoded = Buffer.from(sessionId, 'utf8').toString('base64url');
  return vscode.Uri.parse(
    `${CHAT_SESSION_SCHEME}://${LOCAL_SESSION_AUTHORITY}/${encoded}`
  );
}

/** Discovers every workspace on this machine that has stored chat sessions. */
export async function getChatWorkspaces(
  context: vscode.ExtensionContext
): Promise<ChatWorkspace[]> {
  const { dir: workspaceStorageDir, currentHash } =
    await locateWorkspaceStorage(context);
  if (!workspaceStorageDir || !(await exists(workspaceStorageDir))) {
    return [];
  }

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(workspaceStorageDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const workspaces: ChatWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const hash = entry.name;
    const sessionsDir = path.join(workspaceStorageDir, hash, CHAT_SESSIONS_DIR);
    const isCurrent = hash === currentHash;
    if (!isCurrent && !(await exists(sessionsDir))) {
      continue;
    }

    const info = await readWorkspaceInfo(workspaceStorageDir, hash);
    workspaces.push({
      id: `chatws:${hash}`,
      label: isCurrent ? 'This workspace' : info.names[0] ?? hash.slice(0, 8),
      hash,
      fsPath: sessionsDir,
      isCurrent,
      lastUsed: await lastUsedAt(sessionsDir),
      target: info.target,
      isWorkspaceFile: info.isWorkspaceFile,
    });
  }

  // Recency beats alphabetical here: the workspace you were last in should be on top.
  workspaces.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) {
      return a.isCurrent ? -1 : 1;
    }
    if (a.lastUsed !== b.lastUsed) {
      return (b.lastUsed ?? 0) - (a.lastUsed ?? 0);
    }
    return a.label.localeCompare(b.label);
  });

  return workspaces;
}

/** Newest mtime among a workspace's session logs, without reading their contents. */
async function lastUsedAt(sessionsDir: string): Promise<number | undefined> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return undefined;
  }

  const times = await Promise.all(
    files
      .filter((f) => f.endsWith('.jsonl'))
      .map(async (f) => {
        try {
          return (await fs.stat(path.join(sessionsDir, f))).mtimeMs;
        } catch {
          return 0;
        }
      })
  );

  return times.length ? times.reduce((a, b) => Math.max(a, b), 0) : undefined;
}

/**
 * The most recently used chats across every workspace. Stating all logs is cheap;
 * parsing them is not, so only as many as are needed to fill `limit` are read.
 */
export async function listRecentSessions(
  context: vscode.ExtensionContext,
  limit: number
): Promise<RecentChatSession[]> {
  const workspaces = await getChatWorkspaces(context);
  const candidates: {
    fsPath: string;
    mtimeMs: number;
    workspace: ChatWorkspace;
  }[] = [];

  await Promise.all(
    workspaces.map(async (workspace) => {
      let files: string[];
      try {
        files = await fs.readdir(workspace.fsPath);
      } catch {
        return;
      }
      await Promise.all(
        files
          .filter((f) => f.endsWith('.jsonl'))
          .map(async (f) => {
            const fsPath = path.join(workspace.fsPath, f);
            try {
              const stat = await fs.stat(fsPath);
              candidates.push({ fsPath, mtimeMs: stat.mtimeMs, workspace });
            } catch {
              // Unreadable logs are simply skipped.
            }
          })
      );
    })
  );

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const recent: RecentChatSession[] = [];
  for (
    let i = 0;
    i < candidates.length && recent.length < limit;
    i += RECENT_BATCH
  ) {
    const batch = candidates.slice(i, i + RECENT_BATCH);
    const parsed = await Promise.all(batch.map((c) => readSession(c.fsPath)));
    parsed.forEach((session, index) => {
      if (session) {
        recent.push({ session, workspace: batch[index].workspace });
      }
    });
  }

  return recent.slice(0, limit);
}

/** Lists the non-empty chat sessions of a workspace, most recently used first. */
export async function listChatSessions(
  sessionsDir: string
): Promise<ChatSession[]> {
  let files: string[];
  try {
    files = await fs.readdir(sessionsDir);
  } catch {
    return [];
  }

  const sessions = await Promise.all(
    files
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => readSession(path.join(sessionsDir, f)))
  );

  return sessions
    .filter((s): s is ChatSession => s !== undefined)
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Reads the prefix of a session log and derives a title. Empty chats are skipped. */
async function readSession(fsPath: string): Promise<ChatSession | undefined> {
  let handle: import('fs/promises').FileHandle;
  try {
    handle = await fs.open(fsPath, 'r');
  } catch {
    return undefined;
  }

  let title: string | undefined;
  let firstMessage: string | undefined;
  let createdAt: number | undefined;
  let requestCount = 0;
  let modifiedAt: number;

  try {
    const stat = await handle.stat();
    modifiedAt = stat.mtimeMs;

    const length = Math.min(stat.size, HEAD_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);

    let text = buffer.toString('utf8');
    if (stat.size > length) {
      // Drop the trailing line: it is truncated, and may even split a UTF-8 char.
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline < 0 ? '' : text.slice(0, lastNewline);
    }

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let record: any;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }

      // kind 0 is a full snapshot; later lines patch individual keys.
      if (record.kind === 0 && record.v) {
        if (typeof record.v.creationDate === 'number') {
          createdAt = record.v.creationDate;
        }
        if (typeof record.v.customTitle === 'string' && record.v.customTitle) {
          title = record.v.customTitle;
        }
        firstMessage = collect(record.v.requests) ?? firstMessage;
      } else if (Array.isArray(record.k) && record.k[0] === 'customTitle') {
        if (typeof record.v === 'string' && record.v) {
          title = record.v;
        }
      } else if (Array.isArray(record.k) && record.k[0] === 'requests') {
        firstMessage = collect(record.v) ?? firstMessage;
      }
    }
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }

  function collect(requests: unknown): string | undefined {
    if (!Array.isArray(requests)) {
      return undefined;
    }
    requestCount += requests.length;
    for (const request of requests) {
      const text = request?.message?.text;
      if (typeof text === 'string' && text.trim()) {
        return text;
      }
    }
    return undefined;
  }

  if (!title && !firstMessage) {
    return undefined; // A chat that was opened but never used.
  }

  return {
    sessionId: path.basename(fsPath, '.jsonl'),
    fsPath,
    title: title || summarize(firstMessage!),
    requestCount,
    createdAt,
    modifiedAt,
  };
}

/** Turns the opening prompt into a one-line label for chats with no generated title. */
function summarize(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 70 ? `${oneLine.slice(0, 69)}\u2026` : oneLine;
}
