use serde_json::Value;
use tauri::{AppHandle, Manager, Theme};

const NATIVE_TITLEBAR_PLATFORM: &str = "linux";

fn monaco_theme_name(theme: Theme) -> &'static str {
    match theme {
        Theme::Dark => "vs-dark",
        _ => "vs-light",
    }
}

/// Matches Node's process.platform values (darwin/win32/linux), since
/// monacorc.json's `platform` field originated from the Electron build and
/// nothing downstream should have to know which shell produced it.
fn node_style_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Mirrors main.js's sendMonacoSettings: read monacorc.json, layer in the
/// current theme/platform, and hand the merged object to the renderer.
pub fn build_monaco_settings(app: &AppHandle, theme: Theme) -> Result<Value, String> {
    let resource_path = app
        .path()
        .resolve("monacorc.json", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("failed to resolve monacorc.json: {e}"))?;
    let raw = std::fs::read_to_string(&resource_path)
        .map_err(|e| format!("failed to read {}: {e}", resource_path.display()))?;
    let mut settings: Value =
        serde_json::from_str(&raw).map_err(|e| format!("failed to parse monacorc.json: {e}"))?;

    let platform = node_style_platform();
    if let Some(obj) = settings.as_object_mut() {
        obj.insert("theme".into(), monaco_theme_name(theme).into());
        obj.insert("platform".into(), platform.into());
        obj.insert(
            "useNativeTitleBar".into(),
            (platform == NATIVE_TITLEBAR_PLATFORM).into(),
        );
    }

    Ok(settings)
}
