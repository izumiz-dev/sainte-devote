use tauri::menu::{Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime};

pub fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let new_tab = MenuItem::with_id(app, "new-tab", "New Tab", true, Some("CmdOrCtrl+N"))?;
    let open_file = MenuItem::with_id(app, "open-file", "Open File...", true, Some("CmdOrCtrl+O"))?;
    let save = MenuItem::with_id(app, "save", "Save", true, Some("CmdOrCtrl+S"))?;
    let save_as = MenuItem::with_id(
        app,
        "save-as",
        "Save As...",
        true,
        Some("CmdOrCtrl+Shift+S"),
    )?;
    let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let export_all = MenuItem::with_id(
        app,
        "export-all",
        "Export All Tabs (.zip)",
        true,
        Some("CmdOrCtrl+Shift+E"),
    )?;

    let file_builder = SubmenuBuilder::new(app, "File")
        .item(&new_tab)
        .item(&open_file)
        .separator()
        .item(&save)
        .item(&save_as)
        .separator()
        .item(&close_tab)
        .separator()
        .item(&export_all);
    #[cfg(not(target_os = "macos"))]
    let file_builder = file_builder.separator().quit();
    let file_menu = file_builder.build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View").fullscreen().build()?;

    let mut window_builder = SubmenuBuilder::new(app, "Window").minimize().maximize();
    #[cfg(target_os = "macos")]
    {
        window_builder = window_builder.separator().bring_all_to_front();
    }
    #[cfg(not(target_os = "macos"))]
    {
        window_builder = window_builder.close_window();
    }
    let window_menu = window_builder.build()?;

    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = {
        let app_menu = SubmenuBuilder::new(app, "Sainte Devote")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()?;
        builder.item(&app_menu)
    };

    builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if id == "export-all" {
        let _ = window.emit("request-export-all", ());
    } else if matches!(
        id,
        "new-tab" | "open-file" | "save" | "save-as" | "close-tab"
    ) {
        let _ = window.emit("menu-action", id);
    }
}
