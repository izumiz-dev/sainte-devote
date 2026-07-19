mod external;
mod file_sync;
mod files;
mod settings;
mod validate;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

// Global state for active file paths (files user has explicitly selected)
pub struct ActiveFilePathsState(Mutex<HashSet<PathBuf>>);

// Pending file opens queued before the renderer signaled readiness. Mirrors
// main.js's filePathsToOpen[] + flushPendingFileOpens(): argv / macOS
// open-file / second-instance can arrive before the webview has registered its
// event listeners, so we hold them here and flush on renderer_ready.
pub struct PendingFileOpensState(Mutex<Vec<PathBuf>>);

// Whether the renderer has signaled renderer_ready. Lets late-arriving open
// requests (single-instance, second open-file after launch) emit immediately
// instead of queuing forever.
pub struct RendererReadyState(AtomicBool);

fn emit_monaco_settings(window: &tauri::WebviewWindow) {
    let theme = window.theme().unwrap_or(tauri::Theme::Light);
    match settings::build_monaco_settings(window.app_handle(), theme) {
        Ok(payload) => {
            if let Err(e) = window.emit("monaco-settings", payload) {
                eprintln!("failed to emit monaco-settings: {e}");
            }
        }
        Err(e) => eprintln!("failed to build monaco settings: {e}"),
    }
}

// Mirrors main.js's 'renderer-ready' handler: renderer.js registers all its
// IPC listeners synchronously during Monaco's AMD load, then sends this as
// the last step. `window` is injected by Tauri from the invoking webview —
// the JS-side invoke('renderer_ready') call takes no extra argument for it.
// Emitting monaco-settings only once this fires (rather than from `setup`,
// which races the renderer's event.listen() Promise) avoids losing the
// event to a startup race. Also flushes any file opens queued during startup
// (argv / macOS open-file / second-instance).
#[tauri::command]
fn renderer_ready(
    window: tauri::WebviewWindow,
    pending: State<'_, PendingFileOpensState>,
    ready_state: State<'_, RendererReadyState>,
) {
    ready_state
        .0
        .store(true, std::sync::atomic::Ordering::SeqCst);
    emit_monaco_settings(&window);
    flush_pending_opens(window.app_handle(), &window, &pending);
}

// Drains the pending-opens queue and emits a 'file-opened' event per path,
// granting write access (argv / open-file / drag-drop are all explicit user
// gestures). Mirrors main.js flushPendingFileOpens() + openFileInRenderer().
fn flush_pending_opens<R: tauri::Runtime, T: tauri::Emitter<R> + tauri::Manager<R>>(
    app: &AppHandle,
    window: &T,
    pending: &PendingFileOpensState,
) {
    let paths = {
        let mut p = pending.0.lock().unwrap();
        std::mem::take(&mut *p)
    };

    let active = app.state::<ActiveFilePathsState>();
    let sync = app.state::<file_sync::ExternalFileSyncState>();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let content = match files::read_file_content(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("flush_pending_opens: skipping {}: {e}", path.display());
                continue;
            }
        };
        let path_str = match path.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Grant write access (startup open = explicit user gesture)
        {
            let mut p = active.0.lock().unwrap();
            p.insert(path.clone());
        }

        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        files::add_to_recent_files(app, &path, title);
        sync.watch_file(&path, &content);

        let _ = window.emit(
            "file-opened",
            serde_json::json!({
                "filePath": path_str,
                "content": content,
                "readOnly": false,
            }),
        );
    }
}

#[tauri::command]
fn update_window_title(window: tauri::WebviewWindow, title: String) {
    if let Err(e) = window.set_title(&title) {
        eprintln!("failed to set window title: {e}");
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    external::open_external_url(&url)
}

#[tauri::command]
async fn open_file_dialog(
    app: AppHandle,
    active_paths: State<'_, ActiveFilePathsState>,
) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;

    // blocking_* must NOT run on the main thread; async commands run on a
    // worker thread, so this is the correct place to use the blocking dialog.
    // Electron's dialog allowed multiSelections; Tauri's blocking_pick_files
    // mirrors that. Returns [] on cancel, matching the Electron contract.
    let file_paths = app
        .dialog()
        .file()
        .add_filter("Markdown Files", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_files();

    let Some(file_paths) = file_paths else {
        return Ok(Vec::new());
    };

    let sync = app.state::<file_sync::ExternalFileSyncState>();
    let mut files = Vec::new();
    for fp in file_paths {
        let path = match fp.into_path() {
            Ok(p) => p,
            Err(_) => continue,
        };

        // validate + read; skip invalid files (matches Electron's `continue`)
        let content = match files::read_file_content(&path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("open_file_dialog: skipping {}: {e}", path.display());
                continue;
            }
        };

        let path_str = match path.to_str() {
            Some(s) => s.to_string(),
            None => continue,
        };

        // Add to activeFilePaths (write access granted via dialog gesture)
        {
            let mut paths = active_paths.0.lock().unwrap();
            paths.insert(path.clone());
        }

        // Add to recent files
        let title = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        files::add_to_recent_files(&app, &path, title);
        sync.watch_file(&path, &content);

        files.push(serde_json::json!({
            "filePath": path_str,
            "content": content,
        }));
    }

    Ok(files)
}

// Mirrors main.js's 'save-file-to-path' (autosave to an already-bound path).
// Success is SILENT (no event) — only 'save-file-error' is emitted on failure.
// renderer.js's save-file-success listener drives the Save-As binding + toast,
// and must NOT fire on every 300ms autosave, so we deliberately do not emit it
// here (matches the Electron build exactly).
#[tauri::command]
fn save_file_to_path(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
    active_paths: State<'_, ActiveFilePathsState>,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);

    if let Err(e) = files::write_file_content(&path, &content, &active_paths.0) {
        let _ = window.emit("save-file-error", e);
        return Ok(());
    }
    app.state::<file_sync::ExternalFileSyncState>()
        .remember_content(&path, &content);

    // Update recent files timestamp (silent — no save-file-success emit)
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    files::add_to_recent_files(&app, &path, title);

    Ok(())
}
// { content, fileName }; we show the dialog, write, and reply via events:
// 'save-file-success' (path string) or 'save-file-error' (message). Errors are
// emitted as events rather than returned as Err, because renderer.js listens
// for them rather than awaiting the send (it's a fire-and-forget send()).
#[tauri::command]
async fn save_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    content: String,
    file_name: String,
    active_paths: State<'_, ActiveFilePathsState>,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = app
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("Markdown Files", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_save_file();

    let file_path = match file_path {
        Some(p) => p,
        None => return Ok(()), // user cancelled
    };

    let path = match file_path.into_path() {
        Ok(p) => validate::with_default_extension(&p),
        Err(e) => {
            let _ = window.emit("save-file-error", format!("Invalid file path: {e}"));
            return Ok(());
        }
    };

    if let Err(e) = validate::validate_writable_path(&path) {
        let _ = window.emit("save-file-error", e);
        return Ok(());
    }

    // Add to activeFilePaths BEFORE writing (write_file_content checks membership)
    {
        let mut paths = active_paths.0.lock().unwrap();
        paths.insert(path.clone());
    }

    if let Err(e) = files::write_file_content(&path, &content, &active_paths.0) {
        active_paths.0.lock().unwrap().remove(&path);
        let _ = window.emit("save-file-error", e);
        return Ok(());
    }
    app.state::<file_sync::ExternalFileSyncState>()
        .watch_file(&path, &content);

    let path_str = match path.to_str() {
        Some(s) => s.to_string(),
        None => {
            let _ = window.emit("save-file-error", "Invalid UTF-8 in saved path");
            return Ok(());
        }
    };

    // Add to recent files
    let title = path
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string());
    files::add_to_recent_files(&app, &path, title);

    // Notify renderer of success
    window
        .emit("save-file-success", &path_str)
        .map_err(|e| format!("Failed to emit save-file-success: {e}"))?;

    Ok(())
}

#[tauri::command]
fn close_file(
    active_paths: State<'_, ActiveFilePathsState>,
    sync: State<'_, file_sync::ExternalFileSyncState>,
    file_path: String,
) -> Result<(), String> {
    let path = PathBuf::from(&file_path);
    active_paths.0.lock().unwrap().remove(&path);
    sync.unwatch_file(&path);
    Ok(())
}

// Returns recent files as an array of path strings, matching main.js's
// [...recentFilePaths]. renderer.js treats the result as string[] and does
// forEach(filePath => ...).
#[tauri::command]
fn get_recent_files(app: AppHandle) -> Vec<String> {
    files::load_recent_files(&app)
        .into_iter()
        .filter_map(|f| f.path.to_str().map(|s| s.to_string()))
        .collect()
}

// Mirrors main.js's 'open-recent-file': validates the path is in the recent
// list (read-only reopen — no fresh file-selection gesture, so NO write access
// granted), reads content, emits 'file-opened' with readOnly: true.
// Returns { ok: bool, reason?: string } so the renderer can fall back silently.
#[tauri::command]
fn open_recent_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
    _active_paths: State<'_, ActiveFilePathsState>,
) -> serde_json::Value {
    let path = PathBuf::from(&file_path);

    // Must be a tracked recent file (mirrors main.js isTrackedRecentFile)
    let is_tracked = files::load_recent_files(&app)
        .iter()
        .any(|f| f.path == path);
    if !is_tracked {
        return serde_json::json!({ "ok": false, "reason": "File is not in the recent list" });
    }

    let content = match files::read_file_content(&path) {
        Ok(c) => c,
        Err(e) => {
            return serde_json::json!({ "ok": false, "reason": e });
        }
    };

    // Do NOT add to activeFilePaths - recent files are read-only
    // until explicitly opened via file dialog

    // Update timestamp and watch for external changes without granting writes.
    files::add_to_recent_files(&app, &path, None);
    app.state::<file_sync::ExternalFileSyncState>()
        .watch_file(&path, &content);

    // Notify renderer (read-only)
    if let Err(e) = window.emit(
        "file-opened",
        serde_json::json!({
            "filePath": file_path,
            "content": content,
            "readOnly": true
        }),
    ) {
        eprintln!("failed to emit file-opened: {e}");
        return serde_json::json!({ "ok": false, "reason": format!("emit failed: {e}") });
    }

    serde_json::json!({ "ok": true })
}

// Handles DragDrop WindowEvents (tauri 2.11). Enter/Leave drive the drop
// overlay; Drop validates+reads each path and emits 'file-opened' with
// write access granted (drag-drop is an explicit user gesture, matching
// main.js's openFileInRenderer({ grantWriteAccess: true })).
fn handle_drag_drop<R: tauri::Runtime, T: tauri::Emitter<R> + tauri::Manager<R>>(
    window: &T,
    event: &tauri::DragDropEvent,
) {
    match event {
        tauri::DragDropEvent::Enter { .. } => {
            let _ = window.emit("drop-overlay-show", ());
        }
        tauri::DragDropEvent::Leave => {
            let _ = window.emit("drop-overlay-hide", ());
        }
        tauri::DragDropEvent::Drop { paths, .. } => {
            let _ = window.emit("drop-overlay-hide", ());
            let app = window.app_handle().clone();
            let active_paths = app.state::<ActiveFilePathsState>();
            let sync = app.state::<file_sync::ExternalFileSyncState>();
            for path in paths {
                let content = match files::read_file_content(path) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("drag-drop: skipping {}: {e}", path.display());
                        continue;
                    }
                };
                let path_str = match path.to_str() {
                    Some(s) => s.to_string(),
                    None => continue,
                };

                // Grant write access (drag-drop = explicit user gesture)
                {
                    let mut p = active_paths.0.lock().unwrap();
                    p.insert(path.clone());
                }

                let title = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
                files::add_to_recent_files(&app, path, title);
                sync.watch_file(path, &content);

                let _ = window.emit(
                    "file-opened",
                    serde_json::json!({
                        "filePath": path_str,
                        "content": content,
                        "readOnly": false,
                    }),
                );
            }
        }
        // Over fires continuously during the drag; no overlay change needed.
        tauri::DragDropEvent::Over { .. } => {}
        _ => {}
    }
}

// Extract file paths from argv. Unlike main.js (which skipped 2 args in dev
// because electronmon launched as `electron <script>`), Tauri launches the
// compiled binary directly in BOTH dev and release, so argv[0] is always the
// binary and file args start at index 1. Drop flags starting with '-' and
// validate each remaining arg as a readable path.
fn extract_file_paths_from_argv(argv: &[String]) -> Vec<PathBuf> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|p| validate::validate_readable_path(p).is_ok())
        .collect()
}

// Queue file paths for opening once the renderer is ready. If the renderer has
// already signaled readiness, flush immediately; otherwise they wait in the
// pending queue and are drained by the renderer_ready command.
fn queue_or_flush_opens(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }

    let pending = app.state::<PendingFileOpensState>();

    // Check whether renderer_ready has already fired. We use the pending
    // queue's emptiness as a proxy is unreliable, so we track readiness
    // explicitly via a separate state flag.
    let renderer_ready_state = app.state::<RendererReadyState>();
    let ready = renderer_ready_state
        .0
        .load(std::sync::atomic::Ordering::SeqCst);

    if ready {
        // Renderer is up: emit immediately. Push to a throwaway local queue
        // and run the flush path.
        let tmp = PendingFileOpensState(Mutex::new(paths));
        if let Some(window) = app.get_webview_window("main") {
            flush_pending_opens(app, &window, &tmp);
        }
    } else {
        let mut q = pending.0.lock().unwrap();
        q.extend(paths);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second instance launched with file args (e.g. "app file.md").
            let paths = extract_file_paths_from_argv(&argv);
            queue_or_flush_opens(app, paths);
            // Bring the existing window forward.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(ActiveFilePathsState(Mutex::new(HashSet::new())))
        .manage(PendingFileOpensState(Mutex::new(Vec::new())))
        .manage(RendererReadyState(std::sync::atomic::AtomicBool::new(
            false,
        )))
        .invoke_handler(tauri::generate_handler![
            renderer_ready,
            update_window_title,
            open_external,
            open_file_dialog,
            save_file,
            save_file_to_path,
            close_file,
            get_recent_files,
            open_recent_file
        ])
        .setup(|app| {
            let sync = file_sync::ExternalFileSyncState::spawn(app.handle().clone())
                .map_err(std::io::Error::other)?;
            app.manage(sync);

            // Seed the pending queue with argv file paths (CLI launch, e.g.
            // `sainte-devote note.md`). Flushed once the renderer signals ready.
            let argv: Vec<String> = std::env::args().collect();
            let paths = extract_file_paths_from_argv(&argv);
            if !paths.is_empty() {
                let pending = app.state::<PendingFileOpensState>();
                let mut q = pending.0.lock().unwrap();
                q.extend(paths);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::ThemeChanged(theme) => {
                    let is_dark = matches!(theme, tauri::Theme::Dark);
                    if let Err(e) = window.emit("theme-changed", is_dark) {
                        eprintln!("failed to emit theme-changed: {e}");
                    }
                }
                WindowEvent::Focused(true) => {
                    window
                        .app_handle()
                        .state::<file_sync::ExternalFileSyncState>()
                        .recheck_all();
                }
                WindowEvent::Destroyed if window.label() == "main" => {
                    window
                        .app_handle()
                        .state::<file_sync::ExternalFileSyncState>()
                        .stop_all();
                }
                // Drag-and-drop arrives as a WindowEvent variant in tauri 2.11
                // (the older Builder::on_drag_drop_event API was removed). This
                // mirrors main.js openFileInRenderer(grantWriteAccess: true):
                // drag-drop is a user file-selection gesture, so it grants write
                // access and opens the files read-write.
                WindowEvent::DragDrop(drag_event) => {
                    handle_drag_drop(window, drag_event);
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(&event, tauri::RunEvent::Exit) {
                app_handle
                    .state::<file_sync::ExternalFileSyncState>()
                    .shutdown();
            }

            // macOS file association: opening a .md from Finder delivers the
            // path(s) as file:// URLs here. Mirrors Electron's 'open-file'.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<PathBuf> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .filter(|p| validate::validate_readable_path(p).is_ok())
                    .collect();
                queue_or_flush_opens(app_handle, paths);
            }
            let _ = app_handle;
        });
}
