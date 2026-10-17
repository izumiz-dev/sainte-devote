#![warn(clippy::disallowed_methods)]

mod export;
mod external;
mod file_sync;
mod files;
mod fs_open;
mod ipc;
mod menu;
mod session;
mod settings;
mod validate;
mod window_registry;

use tauri::{AppHandle, Manager, State, WindowEvent};

use crate::files::{ActiveFilePathsState, RecentFilesState};
use crate::session::{EmitPolicy, OpenOutcome};
use crate::window_registry::{WindowContext, WindowRegistryState};

const MAX_SETTINGS_BYTES: usize = 16 * 1024;

#[tauri::command]
fn renderer_ready(window: tauri::WebviewWindow) {
    session::on_renderer_ready(window.app_handle(), &window);
}

#[tauri::command]
fn update_window_title(window: tauri::WebviewWindow, title: String) {
    if let Err(error) = window.set_title(&title) {
        eprintln!("failed to set window title: {error}");
    }
}

#[tauri::command]
fn set_title_bar_theme(window: tauri::WebviewWindow, is_dark: bool, follows_system: bool) {
    let theme = if follows_system {
        None
    } else if is_dark {
        Some(tauri::Theme::Dark)
    } else {
        Some(tauri::Theme::Light)
    };
    if let Err(error) = window.set_theme(theme) {
        eprintln!("failed to set window theme: {error}");
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    external::open_external_url(&url)
}

#[tauri::command]
async fn open_file_dialog(window: tauri::WebviewWindow) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_dialog::DialogExt;

    let file_paths = window
        .dialog()
        .file()
        .add_filter("Markdown Files", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_pick_files();

    let Some(file_paths) = file_paths else {
        return Ok(Vec::new());
    };

    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let mut files = Vec::new();
    for file_path in file_paths {
        let Ok(path) = file_path.into_path() else {
            continue;
        };
        match session::open_one(&app, &path, &label, true, EmitPolicy::IfTransferred) {
            OpenOutcome::Delivered(opened) if !opened.transferred => {
                files.push(serde_json::json!({
                    "filePath": opened.file_path,
                    "content": opened.content,
                }));
            }
            OpenOutcome::Delivered(opened) => {
                session::focus_label(&app, &opened.target);
            }
            OpenOutcome::Rejected(error) => {
                eprintln!("open_file_dialog: skipping {}: {error}", path.display());
            }
            OpenOutcome::Queued => {}
        }
    }
    Ok(files)
}

#[tauri::command]
fn save_file_to_path(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
    content: String,
) -> Result<(), String> {
    session::autosave(&app, window.label(), &file_path, &content);
    Ok(())
}

#[tauri::command]
async fn save_file(
    window: tauri::WebviewWindow,
    content: String,
    file_name: String,
) -> Result<(), String> {
    use tauri_plugin_dialog::DialogExt;

    let file_path = window
        .dialog()
        .file()
        .set_file_name(&file_name)
        .add_filter("Markdown Files", &["md", "markdown", "txt"])
        .add_filter("All Files", &["*"])
        .blocking_save_file();

    let Some(file_path) = file_path else {
        return Ok(());
    };
    let path = match file_path.into_path() {
        Ok(path) => path,
        Err(error) => {
            ipc::emit_to_window(
                window.app_handle(),
                window.label(),
                "save-file-error",
                format!("Invalid file path: {error}"),
            );
            return Ok(());
        }
    };
    session::save_as(window.app_handle(), window.label(), &path, &content);
    Ok(())
}

#[tauri::command]
fn close_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
) -> Result<(), String> {
    session::close_path(&app, window.label(), &file_path);
    Ok(())
}

/// Register the tab this window started dragging, so another window can merge
/// it when the drag is dropped there.
#[tauri::command]
fn begin_tab_drag(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: i64,
    origin_workspace_id: Option<String>,
    title: String,
    content: String,
    file_path: Option<String>,
) -> Result<(), String> {
    if !session::begin_tab_drag(
        &app,
        window.label(),
        tab_id,
        origin_workspace_id,
        title,
        content,
        file_path,
    ) {
        return Err("unknown window".to_string());
    }
    Ok(())
}

/// The drag ended without leaving the webview, so drop the registration.
#[tauri::command]
fn clear_tab_drag(app: AppHandle, window: tauri::WebviewWindow) {
    session::clear_tab_drag(&app, window.label());
}

/// An in-page tab drop landed on this window (Chromium / WebView2, where a
/// page drag is not promoted to a native drag session). `x` / `y` are the drop
/// position in CSS pixels. Resolution is identical to the native drop path:
/// released in this window it commits the reorder, released elsewhere it
/// merges the tab into this window.
#[tauri::command]
fn drop_tab_in_window(app: AppHandle, window: tauri::WebviewWindow, x: f64, y: f64) {
    session::handle_tab_drop(&app, window.label(), Some((x, y)));
}

#[tauri::command]
fn get_recent_files(app: AppHandle, recent: State<'_, RecentFilesState>) -> Vec<String> {
    files::snapshot_recent_files(&app, &recent)
        .into_iter()
        .filter_map(|file| file.path.to_str().map(str::to_string))
        .collect()
}

#[tauri::command]
fn open_recent_file(
    app: AppHandle,
    window: tauri::WebviewWindow,
    file_path: String,
) -> serde_json::Value {
    session::open_recent(&app, window.label(), &file_path)
}

#[tauri::command]
fn open_new_window(app: AppHandle, window: tauri::WebviewWindow) -> Result<String, String> {
    session::create_editor_window(&app, Some(window.label().to_string()))
}

#[tauri::command]
fn open_new_window_with_tab(
    app: AppHandle,
    window: tauri::WebviewWindow,
    tab_id: i64,
    origin_workspace_id: Option<String>,
    tab_title: String,
    tab_content: String,
    file_path: Option<String>,
) -> Result<String, String> {
    session::create_editor_window_with_tab(
        &app,
        session::TabHandoff {
            source_label: window.label(),
            tab_id,
            origin_workspace_id: origin_workspace_id.as_deref(),
            title: &tab_title,
            content: &tab_content,
            file_path: file_path.as_deref(),
        },
        Some(window.label().to_string()),
    )
}

#[tauri::command]
fn get_window_context(
    window: tauri::WebviewWindow,
    registry: State<'_, WindowRegistryState>,
) -> Result<WindowContext, String> {
    registry
        .lock()
        .context(window.label())
        .ok_or_else(|| "unknown window".to_string())
}

#[tauri::command]
fn claim_workspaces(
    window: tauri::WebviewWindow,
    registry: State<'_, WindowRegistryState>,
    ids: Vec<String>,
) -> Result<Vec<String>, String> {
    registry
        .lock()
        .claim(window.label(), &ids)
        .map_err(str::to_string)
}

#[tauri::command]
fn close_window_confirmed(window: tauri::WebviewWindow, registry: State<'_, WindowRegistryState>) {
    let label = window.label().to_string();
    registry.lock().mark_closing(&label);
    if let Err(error) = window.destroy() {
        eprintln!("failed to destroy window {label}: {error}");
    }
}

#[tauri::command]
fn close_window_cancelled(window: tauri::WebviewWindow, registry: State<'_, WindowRegistryState>) {
    registry.lock().clear_close_pending(window.label());
}

#[tauri::command]
fn broadcast_settings(
    window: tauri::WebviewWindow,
    settings: serde_json::Value,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_SETTINGS_BYTES {
        return Err("settings payload exceeds 16 KiB".to_string());
    }
    ipc::emit_except_window(
        window.app_handle(),
        window.label(),
        "settings-changed",
        settings,
    );
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let opened = session::open_argv(app, &argv, std::path::Path::new(&cwd));
            if !opened {
                if let Some(label) = app.state::<WindowRegistryState>().lock().menu_target() {
                    session::focus_label(app, &label);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(WindowRegistryState::new())
        .manage(ActiveFilePathsState::new())
        .manage(RecentFilesState::new())
        .menu(menu::build_menu)
        .on_menu_event(menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            renderer_ready,
            update_window_title,
            set_title_bar_theme,
            open_external,
            open_file_dialog,
            save_file,
            save_file_to_path,
            close_file,
            begin_tab_drag,
            clear_tab_drag,
            drop_tab_in_window,
            get_recent_files,
            open_recent_file,
            open_new_window,
            open_new_window_with_tab,
            get_window_context,
            claim_workspaces,
            close_window_confirmed,
            close_window_cancelled,
            broadcast_settings,
            export::export_tabs_data
        ])
        .setup(|app| {
            let sync = file_sync::ExternalFileSyncState::spawn(app.handle().clone())
                .map_err(std::io::Error::other)?;
            app.manage(sync);

            let argv: Vec<String> = std::env::args().collect();
            let cwd = session::current_dir();
            let paths = session::resolve_argv_paths(&argv, &cwd);
            if !paths.is_empty() {
                let registry = app.state::<WindowRegistryState>();
                let mut registry = registry.lock();
                for path in paths {
                    registry.route_open(path, window_registry::MAIN_LABEL, true);
                }
            }

            #[cfg(windows)]
            for window in app.webview_windows().values() {
                if let Err(error) = window.set_decorations(false) {
                    eprintln!("failed to disable window decorations: {error}");
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::ThemeChanged(theme) => {
                let is_dark = matches!(theme, tauri::Theme::Dark);
                ipc::emit_to_window(
                    window.app_handle(),
                    window.label(),
                    "theme-changed",
                    is_dark,
                );
            }
            WindowEvent::Focused(true) => {
                let label = window.label().to_string();
                window
                    .app_handle()
                    .state::<WindowRegistryState>()
                    .lock()
                    .note_focus(&label);
                window
                    .app_handle()
                    .state::<file_sync::ExternalFileSyncState>()
                    .recheck_all();
            }
            WindowEvent::CloseRequested { api, .. } => {
                let label = window.label().to_string();
                let outcome = window
                    .app_handle()
                    .state::<WindowRegistryState>()
                    .lock()
                    .on_close_requested(&label);
                if outcome == window_registry::CloseRequestOutcome::PreventAndAsk {
                    api.prevent_close();
                    ipc::emit_to_window(window.app_handle(), &label, "window-close-requested", ());
                }
            }
            WindowEvent::Destroyed => {
                let label = window.label().to_string();
                let app = window.app_handle();
                app.state::<WindowRegistryState>()
                    .lock()
                    .destroy_window(&label);
                app.state::<ActiveFilePathsState>().revoke_window(&label);
                app.state::<file_sync::ExternalFileSyncState>()
                    .unwatch_window(&label);
            }
            WindowEvent::DragDrop(drag_event) => {
                if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                    session::handle_drag_drop(&webview, drag_event);
                }
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(&event, tauri::RunEvent::Exit) {
                app_handle
                    .state::<file_sync::ExternalFileSyncState>()
                    .shutdown();
            }

            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                let paths: Vec<std::path::PathBuf> = urls
                    .iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                session::open_user_paths(app_handle, &paths);
            }
        });
}
