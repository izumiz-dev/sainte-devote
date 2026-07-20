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

- `src-tauri/src/lib.rs`: Tauri setup, managed state, startup file queue, and
  window events.
- `src-tauri/src/files.rs`: open, save, autosave, recent files, and active-path
  write authorization.
- `src-tauri/src/file_sync.rs`: parent-directory watches, hashes, debounce,
  deletion/reappearance, and focus rechecks.
- `src-tauri/src/validate.rs`: path, extension, symlink, and export validation.
- `src-tauri/src/external.rs`: external URL protocol allowlist.
- `src-tauri/src/export.rs`: ZIP export.
- `src-tauri/src/menu.rs`: native menu and renderer event dispatch.
- `frontend/src/tauri-bridge.js`: the `window.electron` compatibility API over
  Tauri commands and events.
- `frontend/src/renderer.js`: tabs, Monaco editors, Markdown preview, settings,
  persistence, and conflict UI.

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
- Keep the CSP restrictive. Do not reintroduce inline scripts.

## Runtime Subtleties

- File watchers monitor parent directories so atomic-save renames remain
  detectable.
- Register and manage `ExternalFileSyncState` at the start of `.setup()` before
  any pending file-open flush can use it.
- Renderer listeners are installed only after Monaco finishes loading. Queue
  startup opens until the renderer emits `renderer-ready`.
- Recent-files opens remain read-only.
- Run through `pnpm tauri:dev`; launching the debug binary directly does not use
  the Tauri CLI frontend server.
- DOMPurify must load before Monaco's AMD loader.
- On macOS, unbundled dev and installed app builds use separate WebKit and
  Application Support roots (`sainte-devote` versus
  `dev.izumiz.sainte-devote`). Export scratch tabs before switching surfaces.

## Completion

Run `pnpm check:tauri`, `cargo test --manifest-path src-tauri/Cargo.toml`,
`pnpm lint`, and `git diff --check`. Manual GUI checks are required for changes
to drag and drop, native menus, file synchronization, startup/open-file paths,
or platform packaging.
