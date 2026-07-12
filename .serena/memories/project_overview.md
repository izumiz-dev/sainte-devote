# Project Overview: Sainte Devote

**Description:**
Sainte Devote is a minimalist text editor built with Electron and Monaco Editor. It features markdown preview capabilities and is designed for distraction-free writing.

**Tech Stack:**
*   **Core:** Electron (Node.js + Chromium)
*   **Editor:** Monaco Editor
*   **Languages:** JavaScript (CommonJS for Main, AMD/Browser for Renderer), HTML, CSS
*   **Package Manager:** pnpm
*   **Persistence:** IndexedDB (implemented in `renderer.js`)
*   **Markdown:** `marked` for parsing, `github-markdown-css` for styling

**Architecture:**
*   **Main Process (`src/main.js`):** Creates window, handles system events, menu, and IPC (file open/save, exports). Watches open files for external changes (fs.watch on parent dirs + sha256 self-write suppression). Loads `monacorc.json`. Queues file opens until the renderer signals `renderer-ready`.
*   **Renderer Process (`src/renderer.js`):** Manages Monaco Editor instances, tab management (custom implementation with IndexedDB), markdown preview, and UI interaction.
*   **Preload (`src/preload.js`):** Security layer/bridge (allowlisted IPC channels).

**Key Features:**
*   Tabbed interface (dynamic creation/deletion).
*   Markdown editing and preview toggle.
*   System theme detection (Dark/Light).
*   Auto-save: scratch tabs to IndexedDB; file-bound tabs to their file (300ms debounce).
*   Open files from Finder/Explorer, dialog, drag & drop, recent files; external edits are detected and synced into the tab, with a reload-or-keep conflict banner when local edits are in flight.
*   Export tabs to Zip.
