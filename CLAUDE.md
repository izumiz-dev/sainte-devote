# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Sainte Devote is a minimalist text editor built with Electron and Monaco Editor. It features markdown preview capabilities and is designed for distraction-free writing.

## Common Development Commands

- `npm start` - Start the application normally
- `npm run dev` - Start in development mode with hot-reload (using electronmon)
- `npm run build` - Build for all platforms
- `npm run build:mac` - Build for macOS only
- `npm run build:win` - Build for Windows only 
- `npm run build:linux` - Build for Linux only

No lint or test commands are configured in this project.

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