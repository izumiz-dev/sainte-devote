# AGENTS.md

This file provides guidance to Codex (codex.ai/code) when working with code in
this repository. See also [CLAUDE.md](CLAUDE.md), which is the authoritative
source for architecture, security boundaries, and completion checks.

## Serena

This project is set up for **Serena** (`.serena/project.yml`, memories in
`.serena/memories/`). When the Serena MCP tools are available, prefer them:

- **Context:** `read_memory` / `list_memories` instead of manually re-reading
  files; `write_memory` when you establish a new convention. Current memories:
  `project_overview`, `suggested_commands`, `code_style_conventions`,
  `task_completion_workflow`, `os_file_security_hardening`,
  `tab_navigation_regression_test`.
- **Code navigation:** `find_symbol`, `get_symbols_overview`,
  `search_for_pattern` instead of raw reads.
- **Editing:** `replace_symbol_body`, `insert_after_symbol`, etc. instead of
  rewriting whole files.

Note: the Serena language server is configured for `typescript`, which also
serves this project's plain JavaScript frontend. Rust symbol analysis via
Serena may be unavailable, so navigate `src-tauri/` with `search_for_pattern`
or raw reads.

## Commands

```bash
pnpm tauri:dev    # vendor assets, then run Tauri dev (primary dev loop)
pnpm check:tauri  # eslint + cargo fmt --check + cargo check + clippy -D warnings
pnpm lint         # ESLint over frontend/src and build scripts (== lint:tauri)
pnpm lint:fix     # ESLint with --fix
pnpm tauri:build  # / build:mac / build:win / build:linux — package via Tauri
```

Rust tests run separately:
`cargo test --manifest-path src-tauri/Cargo.toml`.

Verification is mostly manual (this is a GUI app): run `pnpm tauri:dev` and
exercise the UI. Rust modules carry unit tests (validation, external URLs).
Node 24+, pnpm 10+, and the Rust toolchain are pinned in `mise.toml`.

## Architecture

Sainte Devote is a single-window **Tauri 2** Markdown editor. Monaco Editor and
the Markdown renderer run in the OS WebView; Rust owns all filesystem and OS
integration. There is no Node runtime in the shipped app.

### Rust backend (`src-tauri/src/`)

- **`lib.rs`** — Tauri setup, managed state (`ActiveFilePathsState`,
  `PendingFileOpensState`, `RendererReadyState`), the startup file-open queue,
  Tauri commands, and window events.
- **`files.rs`** — open, save, autosave, recent files, and active-path write
  authorization. Unix reads/writes use `O_NOFOLLOW`.
- **`file_sync.rs`** — parent-directory watches, per-path hashes, debounce,
  deletion/reappearance handling, and focus rechecks.
- **`validate.rs`** — path, extension, regular-file, symlink (lstat over every
  ancestor), NUL-byte, and export validation.
- **`external.rs`** — external URL protocol allowlist (`http`, `https`,
  `mailto`).
- **`export.rs`** — ZIP export.
- **`menu.rs`** — native menu construction and renderer event dispatch.
- **`settings.rs`** — Monaco settings payload assembly.

### Frontend (`frontend/`)

- **`src/renderer.js`** — tabs, per-tab Monaco editors, Markdown preview,
  command palette, settings, persistence (IndexedDB for scratch tabs,
  localStorage for preferences), and conflict UI. No Node access.
- **`src/tauri-bridge.js`** — re-implements the old Electron `window.electron`
  preload API over Tauri commands and events, so the renderer stays independent
  of the shell. `window.__TAURI__` is exposed via `withGlobalTauri`. Channels
  are allowlisted in `RECEIVE_CHANNELS` / `INVOKE_COMMANDS` / `SEND_COMMANDS`;
  adding an IPC message requires registering it here **and** adding the matching
  Rust command.
- **`index.html`** — the renderer DOM. Loads **DOMPurify (UMD) before** Monaco's
  AMD `loader.js` on purpose; don't reorder those `<script>` tags.
- **`src/monaco-bootstrap.js`**, `src/main.css`, `vendor/` (vendored via
  `scripts/vendor.mjs`, run automatically by `tauri:dev` / `tauri:build`).

### Config

- **`src-tauri/tauri.conf.json`** — app identifier (`dev.izumiz.sainte-devote`),
  CSP, `withGlobalTauri`, `frontendDist`, and bundle configuration.
- **`src-tauri/capabilities/main.json`** — WebView permissions. Keep minimal:
  the Tauri equivalent of the old preload IPC allowlist.
- **`monacorc.json`** — Monaco editor config, layered with user font/size
  overrides in the renderer.

## Security model (do not regress)

- Keep Tauri capabilities minimal; filesystem access stays in Rust commands.
- Only paths selected through an explicit user gesture enter
  `ActiveFilePathsState`. Watching or opening a recent file does **not** grant
  write access; recent-files opens stay read-only.
- Validate extension, regular-file status, UTF-8, NUL bytes, and symlinks (via
  lstat on every ancestor) before reading or writing. Unix I/O uses
  `O_NOFOLLOW`.
- External links allow only `http`, `https`, and `mailto`, enforced in Rust
  (`external.rs`).
- Keep DOMPurify before Monaco's AMD loader in `frontend/index.html`. Keep the
  CSP restrictive; do not reintroduce inline scripts.

## Runtime subtleties

- File watchers monitor **parent directories** so atomic-save renames stay
  detectable. A per-path sha256 filters out the app's own autosave writes.
- `ExternalFileSyncState` is registered at the start of `.setup()` before any
  pending file-open flush can use it.
- Renderer IPC listeners exist only after Monaco's AMD modules finish loading.
  Startup opens (argv / macOS open-file / second-instance) are queued in
  `PendingFileOpensState` and flushed when the renderer sends `renderer-ready`;
  `monaco-settings` is emitted only once that fires, to avoid a startup race.
- Run through `pnpm tauri:dev`; launching the debug binary directly skips the
  Tauri CLI frontend server.
- On macOS, unbundled dev and installed builds use separate WebKit and
  Application Support roots (`sainte-devote` vs `dev.izumiz.sainte-devote`).
  Export scratch tabs before switching surfaces.

## Conventions

- ESLint flat config (`eslint.config.js`) + Prettier (`.prettierrc`): single
  quotes, semicolons, 2-space indent, `prefer-const` / `no-var`. The renderer
  uses Monaco's AMD `require`; `hljs` and `DOMPurify` are consumed as globals.
- Rust: `cargo fmt` formatting, and `cargo clippy` must pass with
  `-D warnings` (enforced by `check:tauri`).
