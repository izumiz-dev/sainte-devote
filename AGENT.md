# AGENT.md

**Note:** This project uses **Serena** for development tasks.
*   **Tool Awareness:** Before starting, verify your available tools (e.g., via `get_current_config`) to understand your capabilities.
*   **Context & Memories:** 
    *   **Read:** Use the `read_memory` tool to access project context (`.serena/memories/`) instead of manually reading files.
    *   **Write:** When you learn important project details or establish new conventions, use the `write_memory` tool to save them for future sessions.
*   **Specialized Tools:** Utilize Serena's specialized tools for both reading and writing:
    *   **Analysis:** `find_symbol`, `search_for_pattern`, `get_symbols_overview` (avoid raw `read_file` where possible).
    *   **Modification:** `replace`, `replace_symbol_body`, `rename_symbol` (avoid rewriting entire files with `write_file`).

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

Sainte Devote is a minimalist text editor built with Electron and Monaco Editor. It features markdown preview capabilities and is designed for distraction-free writing.

## Common Development Commands

- `pnpm start` - Start the application normally
- `pnpm dev` - Start in development mode with hot-reload (using electronmon)
- `pnpm build` - Build for all platforms
- `pnpm build:mac` - Build for macOS only
- `pnpm build:win` - Build for Windows only 
- `pnpm build:linux` - Build for Linux only
- `pnpm lint` - Run ESLint
- `pnpm lint:fix` - Run ESLint with auto-fix

## Architecture

### Main Components

- **Main Process** (`src/main.js`) - Electron main process that creates the application window, handles theme switching, and loads Monaco settings from `monacorc.json`
- **Renderer Process** (`src/renderer.js`) - UI logic that initializes Monaco Editor, implements markdown preview, and manages localStorage persistence
- **Preload Script** (`src/preload.js`) - Security layer for IPC communication between main and renderer processes

### Key Files

- `index.html` - Main application HTML entry point
- `src/main.css` - Application styles
- `monacorc.json` - Monaco Editor configuration (themes, fonts, editor behavior)
- `assets/` - Platform-specific application icons

### Application Flow

1. Main process creates Electron window (400x600) with security features enabled
2. Renderer process initializes Monaco Editor with settings from `monacorc.json`
3. Single toggle button (🔄️) switches between edit and preview modes
4. Content is automatically saved to localStorage
5. Theme switching follows system preferences (dark/light)

### Security Configuration

- Context isolation enabled
- Node integration disabled  
- External links open in default browser
- F12 toggles developer tools

## Configuration

Editor settings are managed through `monacorc.json`. This file controls Monaco Editor behavior including themes, fonts, word wrap, and language settings (defaulted to Markdown).

## Platform Support

Builds are configured for macOS (.dmg), Windows (.exe), and Linux (.AppImage) in `package.json` under the `build` section.
