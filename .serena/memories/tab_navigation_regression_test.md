# Tab navigation regression test

## Bug (fixed)
Startup race between IndexedDB restore (`initializeTabs`) and IPC `file-opened` caused:
- `db.transaction` crash when `addTab` called `saveTabData` before `openDatabase()` completed
- Duplicate DOM for same `data-tab` → second tab from left could not be switched

## Fix (in `src/renderer.js`)
- `isInitialized` + `pendingFileOpens` queue for `file-opened` until init completes
- `ensureDatabase()` / guard all IndexedDB ops when `!db`
- `addTab`: skip `saveTabData()` for file-backed tabs (`filePath` set)
- `clearPrematureTabs()` at start of `initializeTabs` to remove race leftovers
- `initPromise` prevents double init; `isInitialized = true` after pending files processed

## Regression test script
`scripts/verify-tab-navigation.js` — Electron integration test (not Jest). Spawns real app with isolated `userData` under `scripts/.verify-user-data-*`.

```bash
pnpm exec electron scripts/verify-tab-navigation.js fresh-files
pnpm exec electron scripts/verify-tab-navigation.js seed-restored
pnpm exec electron scripts/verify-tab-navigation.js restored-files
```

Scenarios:
1. **fresh-files**: new profile + 2 startup files → 2 tabs, no duplicate DOM, all switches OK
2. **seed-restored**: seeds one scratch tab in IndexedDB
3. **restored-files**: restored scratch + 2 startup files → 3 tabs (`Untitled 1`, `alpha.md`, `beta.md`), all switches OK

Checks: tab count, no duplicate `data-tab`, click each tab and verify `.tab.active`, no `unhandledrejection` (e.g. `db.transaction`).

## Not yet committed to repo tooling
User asked to memory-only for now. Future optional steps:
- Add `test:tabs` to `package.json` running all 3 scenarios
- `.gitignore`: `scripts/.verify-*`
- CI optional (Electron on Windows CI is heavy); local regression after `pnpm lint` is sufficient

Fixtures written at runtime: `scripts/.verify-tabs/alpha.md`, `beta.md`.