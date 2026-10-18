use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

use crate::file_sync::ExternalFileSyncState;
use crate::files::{self, ActiveFilePathsState, RecentFilesState};
use crate::ipc;
use crate::validate;
use crate::window_registry::{
    is_workspace_id, normalize_owned_path, PendingOpen, PendingTab, TabDrag, WindowRegistryState,
    MAIN_LABEL, TAB_DRAG_MERGE_GRACE,
};

#[derive(Clone, Copy)]
pub enum EmitPolicy {
    Always,
    IfTransferred,
}

pub struct OpenedFile {
    pub file_path: String,
    pub content: String,
    pub target: String,
    pub transferred: bool,
}

pub enum OpenOutcome {
    Delivered(OpenedFile),
    Queued,
    Rejected(String),
}

pub fn current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub fn resolve_argv_paths(argv: &[String], cwd: &Path) -> Vec<PathBuf> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| normalize_owned_path(Path::new(arg), cwd))
        .filter(|path| validate::validate_readable_path(path).is_ok())
        .collect()
}

pub fn focus_label<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn spawn_editor_window<R: Runtime>(app: AppHandle<R>, anchor: Option<String>) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = create_editor_window(&app, anchor) {
            eprintln!("failed to create window: {error}");
        }
    });
}

pub fn create_editor_window<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Option<String>,
) -> Result<String, String> {
    let label = app
        .state::<WindowRegistryState>()
        .lock()
        .allocate_editor()
        .map_err(str::to_string)?;

    build_reserved_editor_window(app, &label, anchor)
}

/// Build the window for a label `allocate_editor` already reserved. Splitting
/// reservation from construction lets a caller queue work against the window
/// before it exists, which is what a file open needs when there is no window to
/// route to yet.
pub fn build_reserved_editor_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    anchor: Option<String>,
) -> Result<String, String> {
    match build_editor_window(app, label, anchor) {
        Ok(window) => {
            app.state::<WindowRegistryState>()
                .lock()
                .note_focus(window.label());
            Ok(label.to_string())
        }
        Err(error) => {
            app.state::<WindowRegistryState>()
                .lock()
                .destroy_window(label);
            Err(error)
        }
    }
}

/// Open files from an app that is running with no window at all (macOS keeps
/// the process alive after the last window closes).
///
/// `route_open` silently drops an open aimed at a label that does not exist, so
/// the window is reserved first, the paths are queued against it, and only then
/// is the window built — creation has to stay off the event loop thread or the
/// runtime channel deadlocks. `on_renderer_ready` drains the queue once the
/// renderer boots, exactly like a startup open.
pub fn spawn_editor_window_for_paths<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) {
    // Read the anchor before reserving, so the lookup cannot pick the label we
    // are about to create.
    let anchor = app.state::<WindowRegistryState>().lock().menu_target();
    let label = match app.state::<WindowRegistryState>().lock().allocate_editor() {
        Ok(label) => label,
        Err(error) => {
            eprintln!("cannot open files without a window: {error}");
            return;
        }
    };

    for path in paths {
        if let OpenOutcome::Rejected(error) = open_one(app, path, &label, true, EmitPolicy::Always)
        {
            eprintln!("skipping {}: {error}", path.display());
        }
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = build_reserved_editor_window(&app, &label, anchor) {
            eprintln!("failed to create window: {error}");
        }
    });
}

/// Create a new editor window and hand it a tab: a file re-opened through the
/// normal backend path (so validation, write grants and watchers apply), or a
/// scratch tab's title+content delivered once the renderer is ready.
pub struct TabHandoff<'a> {
    pub source_label: &'a str,
    pub tab_id: i64,
    pub origin_workspace_id: Option<&'a str>,
    pub title: &'a str,
    pub content: &'a str,
    pub file_path: Option<&'a str>,
}

pub fn create_editor_window_with_tab<R: Runtime>(
    app: &AppHandle<R>,
    handoff: TabHandoff<'_>,
    anchor: Option<String>,
) -> Result<String, String> {
    let TabHandoff {
        source_label,
        tab_id,
        origin_workspace_id,
        title,
        content,
        file_path,
    } = handoff;
    {
        // A drop onto another window can merge this tab moments before a
        // renderer's detach fallback fires; never spawn a second window that
        // would hold the same tab twice.
        let registry = app.state::<WindowRegistryState>();
        if registry.lock().was_recently_merged(
            source_label,
            tab_id,
            TAB_DRAG_MERGE_GRACE,
            std::time::Instant::now(),
        ) {
            return Err("tab was already merged into another window".to_string());
        }
    }

    let label = create_editor_window(app, anchor)?;

    match file_path {
        Some(path) => {
            // Hand the file over first, otherwise open_one routes it straight
            // back to the window we are taking it from. route_open queues
            // while the new window is still booting, and on_renderer_ready
            // flushes it.
            close_path(app, source_label, path);
            let normalized = normalize_owned_path(Path::new(path), &current_dir());
            let state = app.state::<WindowRegistryState>();
            let routed = state.lock().route_open(normalized, &label, true);
            if !routed.queued && routed.target != label {
                focus_label(app, &routed.target);
            }
        }
        None => {
            let queued = app.state::<WindowRegistryState>().lock().queue_tab(
                &label,
                PendingTab {
                    tab_id,
                    origin_workspace_id: origin_workspace_id
                        .filter(|id| is_workspace_id(id))
                        .map(str::to_string),
                    title: title.to_string(),
                    content: content.to_string(),
                },
            );
            if !queued {
                return Err("window closed before it could receive the tab".to_string());
            }
        }
    }

    Ok(label)
}

fn build_editor_window<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    anchor: Option<String>,
) -> Result<WebviewWindow<R>, String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_LABEL)
        .cloned()
        .ok_or_else(|| "main window config is missing".to_string())?;
    config.label = label.to_string();

    let mut builder = tauri::webview::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| error.to_string())?;
    #[cfg(windows)]
    {
        builder = builder.decorations(false);
    }
    let anchor_label = anchor.or_else(|| app.state::<WindowRegistryState>().lock().menu_target());
    if let Some(anchor_label) = anchor_label {
        if let Some(anchor_window) = app.get_webview_window(&anchor_label) {
            if let Some((x, y)) = cascade_position(&anchor_window) {
                builder = builder.position(x, y);
            }
        }
    }
    let window = builder.build().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    crate::win_drag_drop::install(&window);
    Ok(window)
}

fn cascade_position<R: Runtime>(anchor: &WebviewWindow<R>) -> Option<(f64, f64)> {
    let monitor = anchor.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor();
    if scale <= 0.0 {
        return None;
    }
    let origin = monitor.position();
    let monitor_size = monitor.size();
    let pos = anchor.outer_position().ok()?;
    let size = anchor.outer_size().ok()?;
    let x = pos.x as f64 / scale + 28.0;
    let y = pos.y as f64 / scale + 28.0;
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    let mon_x = origin.x as f64 / scale;
    let mon_y = origin.y as f64 / scale;
    let mon_w = monitor_size.width as f64 / scale;
    let mon_h = monitor_size.height as f64 / scale;
    let fits =
        x >= mon_x && y >= mon_y && x + width <= mon_x + mon_w && y + height <= mon_y + mon_h;
    if fits {
        Some((x, y))
    } else {
        None
    }
}

pub fn open_one<R: Runtime>(
    app: &AppHandle<R>,
    path: &Path,
    requested: &str,
    grant_write: bool,
    emit: EmitPolicy,
) -> OpenOutcome {
    let path = normalize_owned_path(path, &current_dir());
    if let Err(error) = validate::validate_readable_path(&path) {
        return OpenOutcome::Rejected(error);
    }
    let routed =
        app.state::<WindowRegistryState>()
            .lock()
            .route_open(path.clone(), requested, grant_write);
    if routed.queued {
        return OpenOutcome::Queued;
    }

    let content = match files::read_file_content(&path) {
        Ok(content) => content,
        Err(error) => return OpenOutcome::Rejected(error),
    };
    let Some(file_path) = path.to_str().map(str::to_string) else {
        return OpenOutcome::Rejected("Invalid UTF-8 in file path".to_string());
    };

    if routed.grant_write {
        app.state::<ActiveFilePathsState>()
            .grant(&path, &routed.target);
    }
    app.state::<WindowRegistryState>()
        .lock()
        .set_owner(path.clone(), routed.target.clone());
    app.state::<ExternalFileSyncState>()
        .watch_file(&path, &content, &routed.target);

    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    files::add_to_recent_files(app, &app.state::<RecentFilesState>(), &path, title);

    let read_only = !app
        .state::<ActiveFilePathsState>()
        .is_granted(&path, &routed.target);
    let should_emit = match emit {
        EmitPolicy::Always => true,
        EmitPolicy::IfTransferred => routed.transferred,
    };
    if should_emit {
        ipc::emit_to_window(
            app,
            &routed.target,
            "file-opened",
            serde_json::json!({
                "filePath": file_path,
                "content": content,
                "readOnly": read_only,
            }),
        );
    }

    OpenOutcome::Delivered(OpenedFile {
        file_path,
        content,
        target: routed.target,
        transferred: routed.transferred,
    })
}

pub fn open_argv<R: Runtime>(app: &AppHandle<R>, argv: &[String], cwd: &Path) -> bool {
    let paths = resolve_argv_paths(argv, cwd);
    if paths.is_empty() {
        return false;
    }
    let Some(requested) = app.state::<WindowRegistryState>().lock().menu_target() else {
        spawn_editor_window_for_paths(app, &paths);
        return true;
    };
    let mut raised = false;
    for path in paths {
        match open_one(app, &path, &requested, true, EmitPolicy::Always) {
            OpenOutcome::Delivered(opened) => {
                focus_label(app, &opened.target);
                raised = true;
            }
            OpenOutcome::Queued => {
                focus_label(app, &requested);
                raised = true;
            }
            OpenOutcome::Rejected(error) => eprintln!("skipping {}: {error}", path.display()),
        }
    }
    raised
}

#[allow(dead_code)]
pub fn open_user_paths<R: Runtime>(app: &AppHandle<R>, paths: &[PathBuf]) {
    let requested = app
        .state::<WindowRegistryState>()
        .lock()
        .menu_target()
        .unwrap_or_else(|| MAIN_LABEL.to_string());
    for path in paths {
        match open_one(app, path, &requested, true, EmitPolicy::Always) {
            OpenOutcome::Delivered(opened) => {
                if opened.transferred {
                    focus_label(app, &opened.target);
                }
            }
            OpenOutcome::Queued => {}
            OpenOutcome::Rejected(error) => eprintln!("skipping {}: {error}", path.display()),
        }
    }
}

pub fn on_renderer_ready<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    #[cfg(windows)]
    crate::win_drag_drop::install(window);

    let label = window.label().to_string();
    let flush = app
        .state::<WindowRegistryState>()
        .lock()
        .mark_renderer_ready(&label);
    if flush.reset_session {
        app.state::<ActiveFilePathsState>().revoke_window(&label);
        app.state::<ExternalFileSyncState>().unwatch_window(&label);
    }
    for tab in flush.tabs {
        ipc::emit_to_window(
            app,
            &label,
            "open-tab",
            serde_json::json!({
                "title": tab.title,
                "content": tab.content,
                "origin": tab
                    .origin_workspace_id
                    .map(|workspace| serde_json::json!({ "workspace": workspace, "tab": tab.tab_id })),
            }),
        );
    }
    emit_monaco_settings(app, window);
    let mut seen = std::collections::HashSet::new();
    for PendingOpen { path, grant_write } in flush.pending {
        if !seen.insert(path.clone()) {
            continue;
        }
        if let OpenOutcome::Rejected(error) =
            open_one(app, &path, &label, grant_write, EmitPolicy::Always)
        {
            eprintln!("flush pending open {}: {error}", path.display());
        }
    }
}

pub fn emit_monaco_settings<R: Runtime>(app: &AppHandle<R>, window: &WebviewWindow<R>) {
    let theme = window.theme().unwrap_or(tauri::Theme::Light);
    match crate::settings::build_monaco_settings(app, theme) {
        Ok(payload) => ipc::emit_to_window(app, window.label(), "monaco-settings", payload),
        Err(error) => eprintln!("failed to build monaco settings: {error}"),
    }
}

pub fn autosave<R: Runtime>(app: &AppHandle<R>, label: &str, file_path: &str, content: &str) {
    let path = normalize_owned_path(Path::new(file_path), &current_dir());
    if let Err(error) =
        files::write_file_content(&path, content, &app.state::<ActiveFilePathsState>(), label)
    {
        ipc::emit_to_window(app, label, "save-file-error", error);
        return;
    }
    app.state::<ExternalFileSyncState>()
        .remember_content(&path, content);
    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    files::add_to_recent_files(app, &app.state::<RecentFilesState>(), &path, title);
}

pub fn save_as<R: Runtime>(app: &AppHandle<R>, label: &str, path: &Path, content: &str) {
    let path = normalize_owned_path(&validate::with_default_extension(path), &current_dir());
    if let Err(error) = validate::validate_writable_path(&path) {
        ipc::emit_to_window(app, label, "save-file-error", error);
        return;
    }
    if app
        .state::<WindowRegistryState>()
        .lock()
        .conflicts_with_other_owner(&path, label)
    {
        ipc::emit_to_window(
            app,
            label,
            "save-file-error",
            "This file is open in another window",
        );
        return;
    }

    let active = app.state::<ActiveFilePathsState>();
    let newly_granted = !active.is_granted(&path, label);
    let previous_owner = app
        .state::<WindowRegistryState>()
        .lock()
        .owner(&path)
        .cloned();
    active.grant(&path, label);
    app.state::<WindowRegistryState>()
        .lock()
        .set_owner(path.clone(), label);
    if let Err(error) = files::write_file_content(&path, content, &active, label) {
        if newly_granted {
            active.revoke(&path, label);
        }
        if previous_owner.is_none() {
            app.state::<WindowRegistryState>()
                .lock()
                .clear_owner_if(&path, label);
        }
        ipc::emit_to_window(app, label, "save-file-error", error);
        return;
    }
    app.state::<ExternalFileSyncState>()
        .watch_file(&path, content, label);

    let Some(path_str) = path.to_str().map(str::to_string) else {
        ipc::emit_to_window(app, label, "save-file-error", "Invalid UTF-8 in saved path");
        return;
    };
    let title = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string);
    files::add_to_recent_files(app, &app.state::<RecentFilesState>(), &path, title);
    ipc::emit_to_window(app, label, "save-file-success", path_str);
}

pub fn close_path<R: Runtime>(app: &AppHandle<R>, label: &str, file_path: &str) {
    let path = normalize_owned_path(Path::new(file_path), &current_dir());
    app.state::<ActiveFilePathsState>().revoke(&path, label);
    app.state::<ExternalFileSyncState>()
        .unwatch_file(&path, label);
    app.state::<WindowRegistryState>()
        .lock()
        .clear_owner_if(&path, label);
}

/// Register the tab `label` started dragging so a drop landing on another
/// window can pick it up. `tab_id` is echoed back to the source window when
/// the drop is resolved; `origin_workspace_id` names the scratch workspace the
/// tab comes from.
pub fn begin_tab_drag<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    tab_id: i64,
    origin_workspace_id: Option<String>,
    title: String,
    content: String,
    file_path: Option<String>,
) -> bool {
    app.state::<WindowRegistryState>().lock().begin_tab_drag(
        label,
        TabDrag {
            source: label.to_string(),
            tab_id,
            origin_workspace_id: origin_workspace_id.filter(|id| is_workspace_id(id)),
            title,
            content,
            file_path,
        },
    )
}

pub fn clear_tab_drag<R: Runtime>(app: &AppHandle<R>, label: &str) {
    app.state::<WindowRegistryState>()
        .lock()
        .clear_tab_drag(label);
}

/// A native drop with no file paths landed on `target`: a tab was dragged onto
/// this window. Merge it into the window it was dropped on, and tell the source
/// window it no longer owns the tab.
///
/// `position` is the release point in CSS pixels. Releasing over the window the
/// drag started from is an in-window drop: the renderer commits the reorder
/// there (or leaves the tab in place). Detaching into a new window is the
/// renderer's `dragend` fallback for releases that never reached any window at
/// all (desktop, another app).
pub fn handle_tab_drop<R: Runtime>(app: &AppHandle<R>, target: &str, position: Option<(f64, f64)>) {
    let Some(drag) = app
        .state::<WindowRegistryState>()
        .lock()
        .take_tab_drag(target)
    else {
        // An external drag we know nothing about — ignore it.
        return;
    };

    if drag.source == target {
        let (x, y) = position.unwrap_or((0.0, 0.0));
        ipc::emit_to_window(
            app,
            target,
            "tab-dropped-in-window",
            serde_json::json!({ "tabId": drag.tab_id, "x": x, "y": y }),
        );
        return;
    }

    match drag.file_path.as_deref() {
        Some(path) => {
            // Check readability BEFORE releasing the source window's claim:
            // if the file has become unreadable, the tab simply stays in its
            // window with grant, watcher and owner intact, so autosave keeps
            // working without the transfer.
            let normalized = normalize_owned_path(Path::new(path), &current_dir());
            if let Err(error) = files::read_file_content(&normalized) {
                eprintln!("tab-drop: cannot transfer {path}: {error}");
                return;
            }
            // Hand the file over next, otherwise open_one routes it straight
            // back to the window we are taking it from.
            close_path(app, &drag.source, path);
            if let OpenOutcome::Rejected(error) =
                open_one(app, Path::new(path), target, true, EmitPolicy::Always)
            {
                eprintln!("tab-drop: cannot open {path}: {error}");
                // Rare race between the read and the open: re-establish the
                // tab on its source window so it stays usable there.
                app.state::<WindowRegistryState>().lock().record_merge(
                    &drag.source,
                    drag.tab_id,
                    std::time::Instant::now(),
                );
                if let OpenOutcome::Rejected(restore_error) = open_one(
                    app,
                    Path::new(path),
                    &drag.source,
                    true,
                    EmitPolicy::IfTransferred,
                ) {
                    eprintln!("tab-drop: restore to source failed {path}: {restore_error}");
                }
                return;
            }
        }
        None => {
            ipc::emit_to_window(
                app,
                target,
                "open-tab",
                serde_json::json!({
                    "title": drag.title,
                    "content": drag.content,
                    "origin": drag
                        .origin_workspace_id
                        .map(|workspace| serde_json::json!({
                            "workspace": workspace,
                            "tab": drag.tab_id,
                        })),
                }),
            );
        }
    }

    // The transferred tab now lives here; remember the hand-off so a detach
    // fallback racing the `tab-drag-consumed` below cannot spawn a duplicate.
    app.state::<WindowRegistryState>().lock().record_merge(
        &drag.source,
        drag.tab_id,
        std::time::Instant::now(),
    );
    ipc::emit_to_window(app, &drag.source, "tab-drag-consumed", drag.tab_id);
}

pub fn open_recent<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    file_path: &str,
) -> serde_json::Value {
    let cwd = current_dir();
    let path = normalize_owned_path(Path::new(file_path), &cwd);
    let files = files::snapshot_recent_files(app, &app.state::<RecentFilesState>());
    let tracked = files
        .iter()
        .any(|file| file.path == path || normalize_owned_path(&file.path, &cwd) == path);
    if !tracked {
        return serde_json::json!({ "ok": false, "reason": "File is not in the recent list" });
    }
    match open_one(app, &path, label, false, EmitPolicy::Always) {
        OpenOutcome::Delivered(opened) => {
            if opened.transferred {
                focus_label(app, &opened.target);
            }
            serde_json::json!({ "ok": true })
        }
        OpenOutcome::Queued => serde_json::json!({ "ok": true }),
        OpenOutcome::Rejected(reason) => serde_json::json!({ "ok": false, "reason": reason }),
    }
}

/// Convert a native (physical pixel) drag position to CSS pixels for the
/// renderer.
fn to_css_position<R: Runtime>(
    window: &WebviewWindow<R>,
    position: &tauri::PhysicalPosition<f64>,
) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let scale = if scale > 0.0 { scale } else { 1.0 };
    (position.x / scale, position.y / scale)
}

pub fn handle_drag_drop<R: Runtime>(window: &WebviewWindow<R>, event: &tauri::DragDropEvent) {
    let label = window.label().to_string();
    let app = window.app_handle();
    match event {
        // Only show the drop overlay when actual files enter the window.
        // HTML5 tab drags inside the WKWebView also surface as native
        // DragDropEvent::Enter with empty paths — those must not trigger
        // the file-drop UI.
        tauri::DragDropEvent::Enter { paths, .. } => {
            if !paths.is_empty() {
                ipc::emit_to_window(app, &label, "drop-overlay-show", ());
            }
        }
        tauri::DragDropEvent::Leave => {
            ipc::emit_to_window(app, &label, "drop-overlay-hide", ());
        }
        // While a tab drag hovers this window, stream the pointer position to
        // the renderer. WKWebView promotes page drags with a custom MIME type
        // to a native drag session and then delivers NO dragenter/dragover/drop
        // to the page, so this stream is the only way to drive the in-window
        // insertion preview.
        tauri::DragDropEvent::Over { position, .. } => {
            if app
                .state::<WindowRegistryState>()
                .lock()
                .owns_tab_drag(&label)
            {
                let (x, y) = to_css_position(window, position);
                ipc::emit_to_window(
                    app,
                    &label,
                    "tab-drag-over",
                    serde_json::json!({ "x": x, "y": y }),
                );
            }
        }
        tauri::DragDropEvent::Drop { paths, position } => {
            ipc::emit_to_window(app, &label, "drop-overlay-hide", ());
            if paths.is_empty() {
                // No files — a tab drag landed on this window.
                let css = to_css_position(window, position);
                handle_tab_drop(app, &label, Some(css));
                return;
            }
            for path in paths {
                match open_one(app, path, &label, true, EmitPolicy::Always) {
                    OpenOutcome::Delivered(opened) if opened.transferred => {
                        focus_label(app, &opened.target);
                    }
                    OpenOutcome::Rejected(error) => {
                        eprintln!("drag-drop: skipping {}: {error}", path.display());
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}
