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
*   **Main Process (`src/main.js`):** Creates window, handles system events, menu, and IPC (file saving, exports). Loads `monacorc.json`.
*   **Renderer Process (`src/renderer.js`):** Manages Monaco Editor instances, tab management (custom implementation with IndexedDB), markdown preview, and UI interaction.
*   **Preload (`src/preload.js`):** Security layer/bridge.

**Key Features:**
*   Tabbed interface (dynamic creation/deletion).
*   Markdown editing and preview toggle.
*   System theme detection (Dark/Light).
*   Auto-save to IndexedDB.
*   Export tabs to Zip.
