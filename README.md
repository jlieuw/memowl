# Memowl

Browse and manage **GitHub Copilot's native agent memories** from a dedicated sidebar in VS Code.

Copilot's agent quietly accumulates memory files (project conventions, decisions, gotchas) as you work. They live as plain Markdown on your machine, but there is no built-in UI to see or manage them. Memowl fills that gap — and, unlike a plain file browser, it understands Copilot's **scope model** and maps opaque `workspaceStorage` hashes back to the real workspace they belong to.

## Features

- **Scope-aware tree** — memory roots grouped as:
  - **User (global)** — shared across all workspaces
  - **This workspace** — the store for the workspace you have open now
  - **Other workspaces** — every other workspace that has memories, each labelled with the folder / `.code-workspace` name it maps to (not just a hash)
- **Well-known scope hints** — `repo/` and `session/` subfolders are annotated with their meaning.
- **Manage** — create, open, delete memories; reveal in the OS file explorer; copy path.
- **Reliable location** — anchors on the extension's own storage URIs, so it finds the Copilot store correctly across VS Code, Insiders and VSCodium, on any OS.

## Scopes explained

Copilot keeps memories in three scopes, and Memowl surfaces all of them so you always know *where* a note applies:

| Scope | Where it lives | Lifetime | Typically holds |
|-------|----------------|----------|-----------------|
| **User (global)** | `globalStorage` | Persists across every workspace | Personal preferences, cross-project conventions |
| **Repository** (`repo/`) | `workspaceStorage/<hash>` | Tied to the workspace | Project conventions, build commands, architecture facts |
| **Session** (`session/`) | `workspaceStorage/<hash>` | The current chat session only | Scratch notes, in-progress task context |

> Repository and session memories are keyed to a **workspace hash**, not a git repo — see the next section.

## Install

Install **Memowl** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=jlieuw.memowl), or from the Extensions view with:

```
ext install jlieuw.memowl
```

Every release is also published on the [GitHub Releases page](https://github.com/jlieuw/memowl/releases) with a downloadable `.vsix`.

## Why the hash mapping matters

Copilot's repository-scoped memory is keyed to a **workspace hash**, not to a git repo. Open the same folder as part of a different (e.g. multi-root) workspace and it gets a *different* store. Memowl shows this explicitly so you always know which memories apply where.

## Where memories are stored

```
<User>/globalStorage/GitHub.copilot-chat/memory-tool/memories/            <- User (global)
<User>/workspaceStorage/<hash>/GitHub.copilot-chat/memory-tool/memories/  <- per-workspace (repo/, session/)
```

## Run the prototype

```powershell
npm install
npm run compile
```

Then press `F5` (**Run Memowl**) to launch an Extension Development Host, and open the **Memowl** icon in the Activity Bar.

## Status

Early prototype. Read/manage of the on-disk store only; it does not modify Copilot's runtime behavior.

## Disclaimer

Memowl is an independent, community-built tool and is not affiliated with, endorsed by, or sponsored by GitHub or Microsoft. "GitHub" and "Copilot" are trademarks of their respective owners, referenced here only to describe interoperability.

