# AGENT.md

This project uses Serena for JavaScript navigation and memory when its MCP
tools are available. Rust symbol analysis may be unavailable because Serena is
configured for TypeScript.

Sainte Devote is a Tauri 2 application. Read [CLAUDE.md](CLAUDE.md) for the
current architecture, security boundaries, commands, and completion checks.

Core paths:

- `src-tauri/src/`: Rust commands, validation, file synchronization, menu, and
  platform integration.
- `frontend/`: Monaco renderer and Tauri compatibility bridge.
- `src-tauri/tauri.conf.json`: application, CSP, and bundle configuration.
- `src-tauri/capabilities/main.json`: WebView permissions.
- `docs/rust-rewrite-plan.md`: migration status and remaining release checks.

Do not alter or commit unrelated local changes in `.serena/project.yml` or the
untracked `AGENTS.md`.
