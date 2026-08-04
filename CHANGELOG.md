# Change Log

All notable changes to Memowl are documented here.

## [0.1.0] - 2026-08-04

### Added

- **Copilot Chat Sessions** view: browse your Copilot chat history grouped by the workspace it belongs to, with titles and last-used times.
- Resume a chat by clicking it. Chats from another workspace offer to reopen that workspace in a new window and continue there.
- Grouping toggle in the view title bar: **Workspace** (ordered by most recent chat, current workspace pinned first) or **Recency** (a flat list across every workspace, bucketed into Today / Yesterday / Previous 7 days / Previous 30 days / Older).
- Context menu actions to open the raw session log, reveal it in the OS file explorer, copy its path, or open the owning workspace.

### Changed

- Tooltips now escape names and titles read from disk instead of interpolating them into markdown.

## [0.0.2] - 2026-07-13

- Release-driven publishing: tagged GitHub Releases now publish to the Marketplace and attach a downloadable `.vsix`.
- README: added install instructions (Marketplace link and `ext install jlieuw.memowl`).

## [0.0.1] - 2026-07-13

- Initial prototype.
- Scope-aware tree of GitHub Copilot's native agent memories (User/global, repository, session).
- Maps `workspaceStorage` hashes back to real workspace / `.code-workspace` names.
- Create, open, and delete memories; reveal in the OS file explorer; copy path.
- Auto-refresh via file watchers and on view focus.
