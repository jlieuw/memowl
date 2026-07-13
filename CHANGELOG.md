# Change Log

All notable changes to Memowl are documented here.

## [0.0.2] - 2026-07-13

- Release-driven publishing: tagged GitHub Releases now publish to the Marketplace and attach a downloadable `.vsix`.
- README: added install instructions (Marketplace link and `ext install jlieuw.memowl`).

## [0.0.1] - 2026-07-13

- Initial prototype.
- Scope-aware tree of GitHub Copilot's native agent memories (User/global, repository, session).
- Maps `workspaceStorage` hashes back to real workspace / `.code-workspace` names.
- Create, open, and delete memories; reveal in the OS file explorer; copy path.
- Auto-refresh via file watchers and on view focus.
