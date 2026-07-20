use std::path::{Path, PathBuf};

/// Allowed file extensions for opening and saving. Mirrors main.js's
/// ALLOWED_EXTENSIONS (Set(['.md', '.markdown', '.txt'])).
const ALLOWED_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];

/// File extension allowlist validation. Returns true if the extension is allowed.
pub fn validate_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ALLOWED_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
        .unwrap_or(false)
}

/// Appends the default Markdown extension when the selected Save As path does
/// not already use an allowed extension. Mirrors Electron's
/// validateWritableFilePath({ allowNewExtension: true }).
pub fn with_default_extension(path: &Path) -> PathBuf {
    if validate_extension(path) {
        return path.to_path_buf();
    }

    let mut path_with_extension = path.as_os_str().to_os_string();
    path_with_extension.push(".md");
    PathBuf::from(path_with_extension)
}

pub fn with_zip_extension(path: &Path) -> PathBuf {
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return path.to_path_buf();
    }

    let mut path_with_extension = path.as_os_str().to_os_string();
    path_with_extension.push(".zip");
    PathBuf::from(path_with_extension)
}

/// Returns true if any component of the path (or the final component itself)
/// is a symbolic link. Mirrors main.js's pathContainsSymlink + the final
/// isSymbolicLink() check in validateReadableFilePath — without it, a symlink
/// swapped into an ancestor dir (or at the leaf) could route reads/writes
/// outside the intended location. Uses lstat (symlink_metadata) so symlinks
/// are NOT followed, and checks every ancestor so a buried mid-path symlink
/// is caught too.
fn path_contains_symlink(path: &Path) -> bool {
    // Check every ancestor (parent, grandparent, ... up to root) — the path
    // itself is included as the first element of Path::ancestors().
    for ancestor in path.ancestors() {
        if std::fs::symlink_metadata(ancestor)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

/// Validates a file path for reading. Checks:
/// - Extension is in allowlist (case-insensitive)
/// - Path contains no NUL characters
/// - No symbolic links in ANY path component (mirrors main.js)
pub fn validate_readable_path(path: &Path) -> Result<(), String> {
    if !validate_extension(path) {
        return Err("File extension not allowed".to_string());
    }

    // Check for NUL characters in path
    if let Some(s) = path.to_str() {
        if s.contains('\0') {
            return Err("Path contains NUL character".to_string());
        }
    } else {
        return Err("Invalid UTF-8 in path".to_string());
    }

    #[cfg(windows)]
    {
        // Windows: reject UNC paths (mirrors main.js isBlockedUncPath)
        let path_str = path.to_str().unwrap_or("");
        if path_str.starts_with("\\\\") {
            return Err("UNC paths not supported".to_string());
        }
    }

    if path_contains_symlink(path) {
        return Err("Symbolic link in path (not allowed for security)".to_string());
    }

    Ok(())
}

/// Validates a file path for writing. In addition to readable validation:
/// - Rejects UNC paths on Windows for now
pub fn validate_writable_path(path: &Path) -> Result<(), String> {
    validate_readable_path(path)?;

    #[cfg(windows)]
    {
        let path_str = path.to_str().unwrap_or("");
        if path_str.starts_with("\\\\") {
            return Err("UNC paths not supported for writing".to_string());
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Save path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err("Save directory does not exist".to_string());
    }

    if path.exists() {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|e| format!("Failed to inspect save path: {e}"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Save path is not a regular file".to_string());
        }
    }

    Ok(())
}

/// Validates a ZIP export path without granting it general file-write access.
pub fn validate_export_path(path: &Path) -> Result<(), String> {
    let Some(path_string) = path.to_str() else {
        return Err("Invalid UTF-8 in path".to_string());
    };
    if path_string.contains('\0') {
        return Err("Path contains NUL character".to_string());
    }

    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Err("Export path must use the .zip extension".to_string());
    }

    #[cfg(windows)]
    if path_string.starts_with("\\\\") {
        return Err("UNC paths not supported for export".to_string());
    }

    if path_contains_symlink(path) {
        return Err("Symbolic link in export path (not allowed for security)".to_string());
    }

    let parent = path
        .parent()
        .ok_or_else(|| "Export path has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err("Export directory does not exist".to_string());
    }

    if path.exists() {
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|error| format!("Failed to inspect export path: {error}"))?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Export path is not a regular file".to_string());
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_path_keeps_allowed_extension_case_insensitively() {
        assert_eq!(
            with_default_extension(Path::new("note.MD")),
            PathBuf::from("note.MD")
        );
    }

    #[test]
    fn save_path_appends_markdown_extension_when_needed() {
        assert_eq!(
            with_default_extension(Path::new("note")),
            PathBuf::from("note.md")
        );
        assert_eq!(
            with_default_extension(Path::new("note.rtf")),
            PathBuf::from("note.rtf.md")
        );
    }

    #[test]
    fn export_path_appends_zip_extension_when_needed() {
        assert_eq!(
            with_zip_extension(Path::new("backup")),
            PathBuf::from("backup.zip")
        );
        assert_eq!(
            with_zip_extension(Path::new("backup.ZIP")),
            PathBuf::from("backup.ZIP")
        );
    }
}
