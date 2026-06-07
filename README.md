# Sainte Devote

[日本語版 (Japanese)](README.ja.md)

Sainte Devote is a multi-tab Markdown editor based on Monaco Editor, built with Electron for cross-platform use.

https://github.com/user-attachments/assets/34639bbc-92eb-42c4-9830-76229d2f9e92

## Features

-   **Command Palette (`Cmd/Ctrl + P`)**: Provides access to editor commands, tab switching, and keyword search across all open tabs.
-   **Syntax Highlighting**: 
    -   **Editor**: Integrated Monaco Editor for Markdown and code editing.
    -   **Preview**: Code block highlighting using `highlight.js`.
-   **Export**: Export all open tabs into a single `.zip` file.
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
    pnpm dev
    ```

## Building

-   **macOS**: `pnpm build:mac`
-   **Windows**: `pnpm build:win`
-   **Linux**: `pnpm build:linux`

The macOS build requires macOS 12 or later.

Build files are generated in the `dist` folder.

## Configuration

Editor settings are managed in `monacorc.json`. Adjust font size, theme, and other Monaco-specific options.

## License

MIT License.
