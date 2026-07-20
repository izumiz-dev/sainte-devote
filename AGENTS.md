# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Serena

This project is set up for **Serena** (`.serena/project.yml`, memories in `.serena/memories/`). When the Serena MCP tools are available, prefer them:

- **Context:** `read_memory` / `list_memories` instead of manually re-reading files; `write_memory` when you establish a new convention. Current memories: `project_overview`, `suggested_commands`, `code_style_conventions`, `task_completion_workflow`.
- **Code navigation:** `find_symbol`, `get_symbols_overview`, `search_for_pattern` instead of raw reads.
- **Editing:** `replace_symbol_body`, `insert_after_symbol`, etc. instead of rewriting whole files.

Note: the Serena language server is configured for `typescript`, which is also used for this project's plain JavaScript.

## Commands

```bash
pnpm dev          # run with hot-reload (electronmon) — primary dev loop
pnpm start        # run without hot-reload
pnpm lint         # ESLint over src/ — run before considering a change done
pnpm lint:fix     # ESLint with --fix
pnpm build:mac    # / build:win / build:linux — package via electron-builder into dist/
```

There is **no test suite**. Verification is manual: run `pnpm dev` and exercise the UI (this is a GUI app). Node 24+ / pnpm 10+ are required (pinned in `mise.toml` and `package.json` `engines`).

## Architecture

A single-window Electron app: a multi-tab Markdown editor built on Monaco Editor. Three source files under `src/`, plus `index.html` (the renderer's DOM) and `monacorc.json` (editor config). `renderer.js` (~1700 lines) holds essentially all app logic; `main.js` and `preload.js` are thin.

### Process boundaries

- **`src/main.js` (main process)** — creates the `BrowserWindow` (hidden/overlay titlebar), builds the native menu, owns OS integration: file open (argv, macOS `open-file`, drag & drop, recent files) and save dialogs, external-file-change watching, ZIP export (JSZip), `nativeTheme` change events, and reading `monacorc.json` from disk. Holds all Node/`fs` access.
- **`src/renderer.js` (renderer)** — wrapped in Monaco's AMD `require([...])`. Owns tabs, editors, Markdown preview, command palette, settings, persistence, and DOM. Has **no Node access** (`nodeIntegration: false`).
- **`src/preload.js` (bridge)** — exposes `window.electron` via `contextBridge`. IPC channels are **allowlisted** in `SEND_CHANNELS` / `RECEIVE_CHANNELS` sets; adding a new IPC message requires adding its channel name here or it is silently blocked.

### Security model (do not regress)

`contextIsolation: true`, `nodeIntegration: false`. Two deliberate chokepoints:
1. **IPC allowlist** in `preload.js` (above).
2. **External-link allowlist** — `openExternalSafely()` in `main.js` only opens `http:`/`https:`/`mailto:`. All in-app navigation is intercepted (`will-navigate`, `setWindowOpenHandler`) and routed through it; preview links go renderer → `open-external` IPC → `openExternalSafely`.
Markdown is rendered through **DOMPurify** (`getMarkdownHtml`) before `innerHTML`. `escapeHtml` guards code blocks.

### Persistence (three destinations)

- **IndexedDB** (`SainteDevoteDB`) — content and metadata of **scratch tabs** (tabs without a `filePath`). Two object stores: `tabs` (id, title, order) and `content` (keyed by `tabId`). Content is saved on every `onDidChangeModelContent`. See `openDatabase` / `save*IndexedDB` / `load*IndexedDB` functions.
- **The file itself** — tabs bound to a file autosave to disk with a 300ms debounce (`scheduleFileAutosave` → `save-file-to-path`). Autosave pauses while the tab is read-only, its file is missing from disk (`fileMissing`), or a conflict banner is unresolved (`conflictTabs`). File-bound tabs are **not** persisted to IndexedDB and are not restored across app restarts.
- **localStorage** (`sainteDevoteSettings`) — user theme + editor/preview font preferences only. See `loadSettings` / `saveSettings`.

### External file sync

The **main process** watches every open file (`watchFileForExternalChanges`) via `fs.watch` on the **parent directory** — atomic saves (temp file + rename) break per-file watches. A per-path sha256 (`rememberFileContent`) filters out the app's own autosave writes; every read re-runs `validateReadableFilePath` first. Real changes reach the renderer as `file-changed-externally` / `file-removed-externally`; `handleExternalFileContent` reloads the tab silently (view state and undo preserved via `pushEditOperations`) or, when local edits are in flight, shows a reload-or-keep banner. A `browser-window-focus` recheck covers missed watcher events (sleep, network drives).

### Rendering / load-order subtleties

- `index.html` loads **DOMPurify (UMD) before** Monaco's AMD `loader.js` on purpose — otherwise DOMPurify registers as an anonymous AMD module and collides with `marked`. Don't reorder these `<script>` tags. `highlight.js` (`hljs`) and `DOMPurify` are consumed as globals in `renderer.js` (declared in `eslint.config.js` globals).
- Each tab gets its own Monaco editor instance in `editors{}`; `markdownCache{}` memoizes rendered HTML per tab.
- The renderer's IPC listeners only exist after Monaco's AMD modules finish loading — later than `did-finish-load`. Main therefore queues file opens until the renderer sends `renderer-ready` (`flushPendingFileOpens`); don't send renderer-bound messages from main during startup without going through that queue.

### Theme flow (three-way: system / light / dark)

The **renderer owns the effective theme** (`getEffectiveIsDark` resolves the user's system/light/dark choice). Main only reports OS changes (`theme-changed`) and applies the Windows titlebar overlay colors when the renderer tells it to via `set-title-bar-theme`. Changing theme logic means touching both sides.

### Command palette (Ctrl/Cmd+P)

`updatePaletteResults` builds results from three sources: static commands (`staticCommands` array — the canonical list of palette actions), tab-name jumps, and full-text content search across **all** tabs (loading non-open tabs' content from IndexedDB). To add a palette command, append to `staticCommands`.

## Config & conventions

- **`monacorc.json`** is the Monaco editor config, read by the main process at load and sent to the renderer over the `monaco-settings` IPC channel (with `theme` injected). User font/size overrides from settings are layered on top in the renderer.
- ESLint flat config (`eslint.config.js`) + Prettier (`.prettierrc`): single quotes, semicolons, 2-space indent, `prefer-const`/`no-var`. Main process is CommonJS `require`; renderer uses Monaco's AMD `require`.
