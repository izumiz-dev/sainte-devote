//! macOS backdrop blur (vibrancy) used by the Window Blur setting.
//!
//! macOS fixes the blur radius per `NSVisualEffectMaterial` and exposes no
//! public API for a numeric radius, so the slider's value only selects a
//! material here; how much of the app's own surface stays in front of that
//! frost is the renderer's continuous half of the control. Tauri cannot remove
//! a vibrancy effect on macOS, so this module talks to `window-vibrancy`
//! directly.

use tauri::{Runtime, WebviewWindow};

/// Maps the renderer's 0-100 blur slider onto an `NSVisualEffectMaterial`.
/// macOS fixes the blur radius per material, so these ranges only pick a tint;
/// the continuous part of the slider lives in the renderer, which scales how
/// much of the app's own surface stays in front of the frost.
#[cfg(target_os = "macos")]
fn material_for(strength: u8) -> Result<Option<window_vibrancy::NSVisualEffectMaterial>, String> {
    use window_vibrancy::NSVisualEffectMaterial;

    Ok(match strength {
        0 => None,
        // Deliberately not NSVisualEffectMaterial::ContentBackground: that
        // material is meant for a window's own content view and fails to
        // composite when the NSVisualEffectView is only a subview sitting
        // behind the webview, which left the window looking unblurred. Menu is
        // the lightest material that does render in that position.
        1..=33 => Some(NSVisualEffectMaterial::Menu),
        34..=66 => Some(NSVisualEffectMaterial::UnderWindowBackground),
        67..=100 => Some(NSVisualEffectMaterial::FullScreenUI),
        other => return Err(format!("window blur strength out of range: {other}")),
    })
}

/// Applies the requested backdrop blur to the calling window. No-op elsewhere.
#[tauri::command]
pub fn set_window_blur<R: Runtime>(window: WebviewWindow<R>, strength: u8) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, strength);
        Ok(())
    }

    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{apply_vibrancy, clear_vibrancy, NSVisualEffectState};

        let material = material_for(strength)?;
        let target = window.clone();
        let (tx, rx) = std::sync::mpsc::channel();

        // NSVisualEffectView has to be touched on the main thread, while
        // commands run on a worker thread, so hop over and wait for the result.
        window
            .run_on_main_thread(move || {
                // apply_vibrancy() inserts a new view on every call instead of
                // replacing the existing one, so always clear the old one first.
                let result = clear_vibrancy(&target)
                    .map_err(|error| format!("failed to clear window blur: {error}"))
                    .and_then(|_| match material {
                        Some(material) => apply_vibrancy(
                            &target,
                            material,
                            Some(NSVisualEffectState::Active),
                            None,
                        )
                        .map_err(|error| format!("failed to apply window blur: {error}")),
                        None => Ok(()),
                    });
                let _ = tx.send(result);
            })
            .map_err(|error| format!("failed to schedule window blur: {error}"))?;

        rx.recv()
            .map_err(|error| format!("window blur task failed: {error}"))?
    }
}
