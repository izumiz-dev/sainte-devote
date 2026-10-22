# AGENTS.md

This file provides guidance to Codex (codex.ai/code) when working with code in
this repository. See also [CLAUDE.md](CLAUDE.md), which is the authoritative
source for architecture, security boundaries, and completion checks.

## Testing

```bash
pnpm test:frontend  # node:test unit tests for the renderer store
cargo test --manifest-path src-tauri/Cargo.toml
pnpm test:e2e:mac   # macOS E2E against the built .app
```

`pnpm test:e2e:mac` drives the real app through the macOS accessibility API
(read/write, open, save, session restore, external-change conflicts, security
boundaries, multiple windows). It needs a built `.app` (`pnpm build:mac`),
Accessibility permission for the terminal, and it **takes over the machine** for
15–25 minutes: touching the app's windows during a run invalidates every case.
See [test/macos/README.md](test/macos/README.md) for prerequisites and coverage.

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

Verification is manual for GUI behaviour: run `pnpm tauri:dev` and exercise the
UI. Rust modules carry unit tests (validation, external URLs); the macOS
regression suite under `test/macos/` covers the file, session, and multi-window
flows automatically (`pnpm test:e2e:mac`). Node 24+, pnpm 10+, and the Rust
toolchain are pinned in `mise.toml`.

## Architecture

Sainte Devote is a single-window **Tauri 2** Markdown editor. Monaco Editor and
the Markdown renderer run in the OS WebView; Rust owns all filesystem and OS
integration. There is no Node runtime in the shipped app.

### Rust backend (`src-tauri/src/`)

- **`lib.rs`** — Tauri setup, managed state (`ActiveFilePathsState`,
  `WindowRegistryState`, `RecentFilesState`, plus `ExternalFileSyncState` from
  `file_sync`), Tauri commands, and the `WindowEvent` / `RunEvent` handlers
  (including the macOS app lifecycle).
- **`session.rs`** — open/save/autosave flows, editor-window creation, and
  native drag-and-drop resolution (merge, detach, in-window drop).
- **`window_registry.rs`** — window labels/roles, per-window workspace claims,
  file ownership, open routing, and the single-slot tab drag payload.
- **`ipc.rs`** — per-window event emit helpers. Use these instead of a
  broadcasting `emit`.
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
  localStorage for preferences), tab drag-and-drop, and conflict UI. No Node
  access.
- **`src/workspace-store.js`** — per-window scratch-tab storage in IndexedDB
  (tabs, content, workspace claim reconciliation, shared "Untitled N" counter).
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
- **`docs/rust-rewrite-plan.md`** — migration status and remaining release
  checks.

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
  CSP restrictive (`form-action 'none'`, `base-uri 'none'`); do not reintroduce
  inline scripts.
- `withGlobalTauri: true` exposes `window.__TAURI__` globally. Maintain DOMPurify
  sanitization and dependencies actively, as arbitrary script execution in the
  webview would directly reach allowlisted IPC commands.
- Tab hand-offs (`begin_tab_drag`, detach into new window) must be backed by
  window file ownership (`owns_path`) and preserve the source window's
  `ActiveFilePathsState` grant so a renderer cannot mint write grants for
  arbitrary paths or escalate a read-only tab to writable.

## Runtime subtleties

- File watchers monitor **parent directories** so atomic-save renames stay
  detectable. A per-path sha256 filters out the app's own autosave writes.
- `ExternalFileSyncState` is registered at the start of `.setup()` before any
  pending file-open flush can use it.
- Renderer IPC listeners exist only after Monaco's AMD modules finish loading.
  Startup opens (argv / macOS open-file / second-instance) are queued per window
  in `WindowRegistry::pending_opens` and flushed when the renderer sends
  `renderer-ready`; `monaco-settings` is emitted only once that fires, to avoid a
  startup race.
- **macOS keeps the app running with no window.** `RunEvent::ExitRequested`
  calls `prevent_exit()` only for the interaction case (`code.is_none()`, i.e.
  every window closed); an explicit quit (Cmd+Q, the Quit menu item) carries a
  code and has to go through. Because a windowless app still receives
  `RunEvent::Opened`, and `route_open` silently drops opens addressed to labels
  it does not know, `session::spawn_editor_window_for_paths` reserves a label and
  queues the paths against it before building the window on the async runtime —
  building a window from the event loop deadlocks. `RunEvent::Reopen` (Dock
  click) restores the windows that still exist, since AppKit reports a
  miniaturized window as "not visible"; only a genuinely empty app spawns one.
- Run through `pnpm tauri:dev`; launching the debug binary directly skips the
  Tauri CLI frontend server.
- On macOS, unbundled dev and installed builds use separate WebKit and
  Application Support roots (`sainte-devote` vs `dev.izumiz.sainte-devote`).
  Export scratch tabs before switching surfaces.
- **Tab drag-and-drop differs per engine.** WKWebView promotes a page drag with
  a custom MIME type to a native drag session, so the page receives only
  `dragstart` / `dragend` (never `dragenter` / `dragover` / `drop`) and Rust
  receives `DragDropEvent::Enter` / `Over` / `Drop` with positions. Chromium
  webviews (WebView2) keep the drag in the page instead. Both paths are
  implemented: Rust streams `tab-drag-over` for the insertion preview and
  resolves `tab-dropped-in-window` / `tab-drag-consumed`, while the DOM
  `dragover` / `drop` handlers cover Chromium and `drop-tab-in-window` resolves
  a DOM drop against the pending payload.
- A drop released **inside** the source window is never "outside": it commits
  the reorder when it lands in the tab bar band, otherwise it leaves the tab in
  place. Detaching into a new window happens only from the `dragend` fallback
  for releases that reached no window at all (desktop, other apps).
- Each window owns a scratch-tab workspace in IndexedDB; "Untitled N" numbers
  come from a shared counter in the `meta` store so they stay unique across
  windows. Transfers record the source workspace + tab id so a crash between
  "remove at source" and "persist at target" cannot resurrect a duplicate.

## Conventions

- ESLint flat config (`eslint.config.js`) + Prettier (`.prettierrc`): single
  quotes, semicolons, 2-space indent, `prefer-const` / `no-var`. The renderer
  uses Monaco's AMD `require`; `hljs` and `DOMPurify` are consumed as globals.
- Rust: `cargo fmt` formatting, and `cargo clippy` must pass with
  `-D warnings` (enforced by `check:tauri`).
