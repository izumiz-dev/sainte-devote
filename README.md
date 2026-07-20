# Sainte Devote

[日本語版 (Japanese)](README.ja.md)

Sainte Devote is a compact, cross-platform Markdown editor built with Rust, Tauri 2, and Monaco Editor.

https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92

## Features

-   **Command Palette (`Cmd/Ctrl + P`)**: Provides access to editor commands, tab switching, and keyword search across all open tabs.
-   **Syntax Highlighting**: 
    -   **Editor**: Integrated Monaco Editor for Markdown and code editing.
    -   **Preview**: Code block highlighting using `highlight.js`.
-   **Export**: Export all open tabs into a single `.zip` file.
-   **File Handling**:
    -   Open `.md` / `.markdown` / `.txt` files via the open dialog, drag & drop, the recent-files list, or directly from Finder / Explorer.
    -   Tabs bound to a file are autosaved back to disk as you type.
    -   Changes made by other programs are detected and synced into the open tab. If you have edits in flight, a banner lets you choose **Reload from disk** or **Keep my version**; deleting the file on disk pauses autosave until you Save As.
-   **Tab Management**:
    -   Draggable tab reordering.
    -   Inline tab renaming.
    -   Automatic saving using IndexedDB.
-   **UI**:
    -   Horizontal scrolling for the tab bar.
    -   Context menu for tab operations.
    -   Toggle between Editor and Preview modes.
-   **Title Bar**: Frameless title bar with native window controls and search access.
-   **Settings (`Cmd/Ctrl + ,`)**: Customize the editor font and the preview font (family and size), plus the theme. Open it from the gear icon, the command palette (`Open Settings`), or the shortcut.
-   **Theming**: Choose **System**, **Light**, or **Dark**. System mode follows the OS setting; Light/Dark force a fixed theme. Switchable from Settings or the command palette (`Theme: Use System / Light / Dark`).

## Installation

1.  Clone the repository:
    ```bash
    git clone git@github.com:izumiz-dev/sainte-devote.git
    cd sainte-devote
    ```
2.  Install dependencies:
    ```bash
    pnpm install
    ```
3.  Run:
    ```bash
    pnpm tauri:dev
    ```

## Building

Run `pnpm tauri:build` on the target operating system. The Tauri configuration produces:

-   **macOS**: `.app` and `.dmg`
-   **Windows**: NSIS installer
-   **Linux**: AppImage and Debian package

The macOS build requires macOS 12 or later.

Build files are generated under `src-tauri/target/release/bundle`.

Before submitting a change, run:

```bash
pnpm check:tauri
cargo test --manifest-path src-tauri/Cargo.toml
```

## Migrating from the Electron Build

Scratch tabs stored by the Electron build are not automatically available to
the Tauri build because the two runtimes use different WebView data stores.
Before upgrading, use **Export All Tabs (.zip)** in the Electron build and keep
the archive as a backup. Files already saved as `.md`, `.markdown`, or `.txt`
are not affected by the application build process.

The unbundled `pnpm tauri:dev` application and an installed macOS `.app` also
use separate WebKit data directories. Export dev scratch tabs before switching
to an installed build. Replacing an installed build with another build that
keeps the same `dev.izumiz.sainte-devote` identifier preserves the installed
build's data; changing the identifier creates a different data store.

## Configuration

Editor settings are managed in `monacorc.json`. Adjust font size, theme, and other Monaco-specific options.

## License

MIT License.
