# Sainte Devote

[日本語版 (Japanese)](README.ja.md)

Sainte Devote is a compact, cross-platform Markdown editor built with Rust, Tauri 2, and Monaco Editor.

https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92

## Features

-   **Command Palette (`Cmd/Ctrl + P`)**: Provides access to editor commands, tab switching, and keyword search across all open tabs.
-   **Syntax Highlighting & Preview**:
    -   **Editor**: Integrated Monaco Editor for Markdown and code editing.
    -   **Preview**: GitHub-flavored Markdown rendering with `highlight.js` code block highlighting, one-click code copy buttons, and GitHub-style alerts (`[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`).
-   **Export**: Export all open tabs in the current window into a single `.zip` file.
-   **File Handling**:
    -   Open `.md` / `.markdown` / `.txt` files via the open dialog, drag & drop, the recent-files list, or directly from Finder / Explorer.
    -   Tabs bound to a file are autosaved back to disk as you type.
    -   Changes made by other programs are detected and synced into the open tab. If you have edits in flight, a banner lets you choose **Reload from disk** or **Keep my version**; deleting the file on disk pauses autosave until you Save As.
-   **Tab & Window Management**:
    -   Draggable tab reordering and inline tab renaming.
    -   Automatic per-window workspace saving using IndexedDB.
    -   Open additional windows (`Cmd/Ctrl + Shift + N`), use **Open in New Window** from the tab context menu, drag a tab out of a window to detach it into a new window, or drop it onto another Sainte Devote window to merge it there.
    -   **Archived Tabs (Trash)**: Closing a non-empty scratch tab automatically moves it to the archive (up to 50 tabs) instead of discarding its contents. Restore or permanently delete archived tabs anytime from the archive button in the tab bar or via the command palette (`Open Archived Tabs`).
-   **UI**:
    -   Horizontal scrolling for the tab bar.
    -   Context menu for tab operations.
    -   Toggle between Editor and Preview modes.
-   **Title Bar**: Frameless title bar with native window controls and search access.
-   **Settings (`Cmd/Ctrl + ,`)**: Customize the editor font and the preview font (family and size), the theme, and—on macOS—**Window Opacity** (30–100%) and **Window Blur** (`Off` / `Dense` / `Sheer` native vibrancy stages). Open it from the gear icon, the command palette (`Open Settings`), or the shortcut.
-   **Theming**: Choose **System**, **Light**, or **Dark**. System mode follows the OS setting; Light/Dark force a fixed theme. Switchable from Settings or the command palette (`Theme: Use System / Light / Dark`).

## Installation

Download the latest installer or package for your operating system from the [Releases](https://github.com/izumiz-dev/sainte-devote/releases) page:

-   **macOS**: `.dmg` (requires macOS 12 or later)
-   **Windows**: `.exe` (NSIS installer)
-   **Linux**: `.AppImage` or `.deb`

## Development

To run the application locally from source:

1.  Clone the repository:
    ```bash
    git clone git@github.com:izumiz-dev/sainte-devote.git
    cd sainte-devote
    ```
2.  Install dependencies:
    ```bash
    pnpm install
    ```
3.  Run the development build:
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
pnpm test:frontend
```

The macOS-only end-to-end suite (`pnpm test:e2e:mac`) drives a built `.app`
through the accessibility API, including multiple windows. See
[test/macos/README.md](test/macos/README.md) for prerequisites and coverage.

## Migrating from the Electron Build

Scratch tabs stored by the Electron build are not automatically available to
the Tauri build because the two runtimes use different WebView data stores.
Before upgrading, use **Export All Tabs (.zip)** in the Electron build and keep
the archive as a backup. Files already saved as `.md`, `.markdown`, or `.txt`
are not affected by the application build process.

The unbundled `pnpm tauri:dev` application and an installed macOS `.app` also
use separate WebKit data directories. **Export All Tabs** exports the current
window only, so export each window before switching to an installed build.
Replacing an installed build with another build that keeps the same
`dev.izumiz.sainte-devote` identifier preserves the installed build's data;
changing the identifier creates a different data store.

Scratch tabs are copied into a new database named `SainteDevoteWorkspaces` on
upgrade, and the previous database is left in place. Export each window before
upgrading. An older 2.0.x build can still show the scratch tabs from before
that upgrade; tabs created after it stay in the new database.

## Configuration

Editor settings are managed in `monacorc.json`. Adjust font size, theme, and other Monaco-specific options.

## License

MIT License.
