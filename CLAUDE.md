# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Commands

```bash
pnpm tauri:dev
pnpm check:tauri
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri:build
```

Node 24+, pnpm 10+, and the Rust toolchain are pinned in `mise.toml`.

## Architecture

Sainte Devote is a single-window Tauri 2 Markdown editor. Monaco Editor and the
existing renderer run in the OS WebView, while Rust owns filesystem and OS
integration.

- `src-tauri/src/lib.rs`: Tauri setup, managed state, Tauri commands, and
  window / app event handling (including the macOS app lifecycle).
- `src-tauri/src/session.rs`: open/save/autosave flows, window creation, and
  native drag-and-drop resolution.
- `src-tauri/src/window_registry.rs`: window labels and roles, per-window
  workspace claims, file ownership, open routing, and the single-slot tab drag.
- `src-tauri/src/ipc.rs`: per-window event emit helpers (never broadcast).
- `src-tauri/src/files.rs`: open, save, autosave, recent files, and active-path
  write authorization.
- `src-tauri/src/file_sync.rs`: parent-directory watches, hashes, debounce,
  deletion/reappearance, and focus rechecks.
- `src-tauri/src/validate.rs`: path, extension, symlink, and export validation.
- `src-tauri/src/external.rs`: external URL protocol allowlist.
- `src-tauri/src/export.rs`: ZIP export.
- `src-tauri/src/menu.rs`: native menu and renderer event dispatch.
- `frontend/src/workspace-store.js`: per-window scratch-tab storage in
  IndexedDB (tabs, content, workspace claim reconciliation, global
  "Untitled N" counter).
- `frontend/src/tauri-bridge.js`: the `window.electron` compatibility API over
  Tauri commands and events.
- `frontend/src/renderer.js`: tabs, Monaco editors, Markdown preview, settings,
  persistence, tab drag-and-drop, and conflict UI.

## Security Model

- Keep Tauri capabilities minimal. Filesystem access stays in Rust commands.
- Only paths selected through an explicit user gesture enter
  `ActiveFilePathsState`; watching or opening a recent file does not grant write
  access.
- Validate extensions, regular-file status, UTF-8, NUL bytes, symlinks, and
  platform-specific path constraints before reading or writing.
- Unix file reads and writes use `O_NOFOLLOW`.
- External links allow only `http`, `https`, and `mailto`, enforced in Rust.
- Keep DOMPurify before Monaco's AMD loader in `frontend/index.html`.
- Keep the CSP restrictive (`form-action 'none'`, `base-uri 'none'`, no inline scripts).
- `withGlobalTauri: true` exposes `window.__TAURI__` globally. Maintain DOMPurify sanitization and dependencies actively, as arbitrary script execution in the webview would directly reach allowlisted IPC commands.
- Tab hand-offs (`begin_tab_drag`, detach into new window) must be backed by window file ownership (`owns_path`) so a renderer cannot mint write grants for arbitrary paths.

## Runtime Subtleties

- File watchers monitor parent directories so atomic-save renames remain
  detectable.
- Register and manage `ExternalFileSyncState` at the start of `.setup()` before
  any pending file-open flush can use it.
- Renderer listeners are installed only after Monaco finishes loading. Queue
  startup opens per window (`WindowRegistry::pending_opens`) until the renderer
  emits `renderer-ready`.
- On macOS, closing the last window leaves the app running: the `ExitRequested`
  handler calls `prevent_exit()` for that interaction case only, so Cmd+Q and the
  Quit menu item still go through. A file opened in that windowless state has no
  window to route to, so it reserves one, queues the paths, and builds the window
  asynchronously. A Dock click (`Reopen`) restores the windows that still exist
  rather than stacking another one.
- Recent-files opens remain read-only.
- Run through `pnpm tauri:dev`; launching the debug binary directly does not use
  the Tauri CLI frontend server.
- DOMPurify must load before Monaco's AMD loader.
- On macOS, unbundled dev and installed app builds use separate WebKit and
  Application Support roots (`sainte-devote` versus
  `dev.izumiz.sainte-devote`). Export scratch tabs before switching surfaces.
- Tab drag-and-drop has no single source of truth for "where did the drag end",
  because the engines disagree. WKWebView promotes a page drag carrying a custom
  MIME type to a native drag session: the page then receives only `dragstart` /
  `dragend` (no `dragenter` / `dragover` / `drop`), while Rust receives
  `DragDropEvent::Enter` / `Over` / `Drop` with positions. Chromium-based
  webviews such as WebView2 keep the drag in the page instead and deliver DOM
  events (and may never promote it to a native drop at all). Both paths are
  therefore implemented: Rust drives the in-window insertion preview and drop
  resolution on WebKit, the DOM `dragover` / `drop` handlers do the same on
  Chromium, and `drop-tab-in-window` lets a DOM drop resolve the pending payload
  so cross-window transfers work even when no native drop is delivered.
- In-window drops are resolved by the drop position (tab bar band = reorder,
  anywhere else in the window = keep the tab). Detaching into a new window only
  happens from the `dragend` fallback when the release never reached a window
  (desktop, another app), which is why a self-drop must never be read as
  "released outside".
- Each window owns a scratch-tab workspace in IndexedDB; "Untitled N" numbers
  come from a shared counter in the `meta` store so they stay unique across
  windows.

## Completion

Run `pnpm check:tauri`, `cargo test --manifest-path src-tauri/Cargo.toml`,
`pnpm test:frontend`, `pnpm lint`, and `git diff --check`. Manual GUI checks are
required for changes to drag and drop, native menus, file synchronization,
startup/open-file paths, or platform packaging.
