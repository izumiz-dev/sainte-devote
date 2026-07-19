use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, Runtime};

use crate::validate;

/// Active file paths that the user has explicitly chosen (via file dialog or drag-drop).
/// Only these paths can be written to via autosave. This implements the security model
/// where writes are only allowed to files the user has selected via a file chooser gesture.
pub type ActiveFilePaths = Mutex<HashSet<PathBuf>>;

/// Recent files entry. Matches the Electron build's recent-files.json format.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecentFile {
    pub path: PathBuf,
    pub timestamp: i64, // Unix timestamp
    pub title: Option<String>,
}

/// Load recent files from app data directory.
pub fn load_recent_files<R: Runtime, T: Manager<R>>(app: &T) -> Vec<RecentFile> {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("Failed to get app data dir: {e}");
            return Vec::new();
        }
    };

    let recent_files_path = app_data_dir.join("recent-files.json");
    if !recent_files_path.exists() {
        return Vec::new();
    }

    let content = match std::fs::read_to_string(&recent_files_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Failed to read recent-files.json: {e}");
            return Vec::new();
        }
    };

    match serde_json::from_str::<Vec<RecentFile>>(&content) {
        Ok(files) => files,
        Err(e) => {
            eprintln!("Failed to parse recent-files.json: {e}");
            Vec::new()
        }
    }
}

/// Save recent files to app data directory.
pub fn save_recent_files<R: Runtime, T: Manager<R>>(app: &T, files: &[RecentFile]) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("Failed to get app data dir: {e}");
            return;
        }
    };

    // Ensure app data directory exists
    if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        eprintln!("Failed to create app data dir: {e}");
        return;
    }

    let recent_files_path = app_data_dir.join("recent-files.json");
    let json = match serde_json::to_string_pretty(files) {
        Ok(j) => j,
        Err(e) => {
            eprintln!("Failed to serialize recent files: {e}");
            return;
        }
    };

    if let Err(e) = std::fs::write(&recent_files_path, json) {
        eprintln!("Failed to write recent-files.json: {e}");
    }
}

/// Add a file to recent files (or update timestamp if already exists).
pub fn add_to_recent_files<R: Runtime, T: Manager<R>>(app: &T, path: &Path, title: Option<String>) {
    let mut recent_files = load_recent_files(app);

    // Remove existing entry with same path if present
    recent_files.retain(|f| f.path != path);

    // Add new entry at the beginning
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;

    recent_files.insert(
        0,
        RecentFile {
            path: path.to_path_buf(),
            timestamp,
            title,
        },
    );

    // Keep only the most recent 10 files (mirrors main.js MAX_RECENT_FILES)
    recent_files.truncate(10);

    save_recent_files(app, &recent_files);
}

/// Read file content with validation and no-follow semantics.
pub fn read_file_content(path: &Path) -> Result<String, String> {
    use std::io::Read;

    validate::validate_readable_path(path)?;

    #[cfg(unix)]
    let mut file = {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|e| format!("Failed to open file (O_NOFOLLOW): {e}"))?
    };

    #[cfg(not(unix))]
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| format!("Failed to open file: {e}"))?;

    let metadata = file
        .metadata()
        .map_err(|e| format!("Failed to inspect file: {e}"))?;
    if !metadata.is_file() {
        return Err("Path is not a regular file".to_string());
    }

    let mut content = String::new();
    file.read_to_string(&mut content)
        .map_err(|e| format!("Failed to read file: {e}"))?;
    Ok(content)
}

/// Write content to file with validation and activeFilePaths check.
/// Mirrors main.js's writeFileNoFollow: O_NOFOLLOW on Unix (rejects if the
/// final path component is a symlink), reparse-point check on Windows.
/// Direct write (no temp+rename) — matches the Electron build, and Phase 3's
/// sha256 self-write filter is what suppresses the resulting watcher echo.
pub fn write_file_content(
    path: &Path,
    content: &str,
    active_paths: &ActiveFilePaths,
) -> Result<(), String> {
    validate::validate_writable_path(path)?;

    // Check if path is in activeFilePaths (user has explicitly chosen this file)
    let paths = active_paths.lock().unwrap();
    if !paths.contains(path) {
        return Err("Path not in activeFilePaths (user did not select this file)".to_string());
    }
    drop(paths);

    // O_NOFOLLOW on Unix: refuse to write through a symlink at the final path.
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        const O_NOFOLLOW: i32 = libc::O_NOFOLLOW;
        std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(O_NOFOLLOW)
            .open(path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, content.as_bytes()))
            .map_err(|e| format!("Failed to write file (O_NOFOLLOW): {e}"))?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(path, content).map_err(|e| format!("Failed to write file: {e}"))?;
    }

    Ok(())
}
