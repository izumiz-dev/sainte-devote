# OS file security hardening (cross-platform)

## Changes
- `open-dropped-file` SEND channel removed; renderer cannot pass arbitrary path strings.
- Drag-drop: `preload.openDroppedFiles(files)` uses `webUtils.getPathForFile` only; main `open-dropped-files` handler validates paths.
- Recent files moved to main (`userData/recent-files.json`); renderer uses `invoke('get-recent-files')` and `invoke('open-recent-file')` (main validates path is in recent list).
- Symlink/junction defense: `pathContainsSymlink` + `fs.lstatSync` in `validateReadableFilePath` / `validateWritableFilePath`.
- `sandbox: true` in BrowserWindow webPreferences.
- `update-window-title`: `setRepresentedFilename` only for paths in `activeFilePaths`.
- Zip export uses `validateExportFilePath` (`.zip` only).
- `close-file` uses `removeFromActiveFilePaths` with validation.

## Verification
```bash
pnpm exec electron scripts/verify-security.js
pnpm exec electron scripts/verify-os-file-integration.js
```