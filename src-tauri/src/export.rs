use serde::Deserialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::Path;
use tauri::{Emitter, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::validate;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportTab {
    filename: String,
    content: String,
}

fn safe_entry_name(filename: &str, index: usize, used_names: &mut HashSet<String>) -> String {
    let basename = filename.rsplit(['/', '\\']).next().unwrap_or("");
    let basename: String = basename
        .chars()
        .filter(|character| {
            !character.is_control() && !matches!(character, ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    let basename = basename.trim();

    let mut candidate = if validate::validate_extension(Path::new(basename)) {
        basename.to_string()
    } else if basename.is_empty() {
        format!("tab_{}.md", index + 1)
    } else {
        format!("{basename}.md")
    };

    if used_names.insert(candidate.to_ascii_lowercase()) {
        return candidate;
    }

    let path = Path::new(&candidate);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("tab")
        .to_string();
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md")
        .to_string();
    let mut suffix = 1;
    loop {
        candidate = format!("{stem}_{suffix}.{extension}");
        if used_names.insert(candidate.to_ascii_lowercase()) {
            return candidate;
        }
        suffix += 1;
    }
}

fn default_export_filename() -> String {
    let date = time::OffsetDateTime::now_utc().date();
    let formatted = date
        .format(time::macros::format_description!("[year][month][day]"))
        .unwrap_or_else(|_| "backup".to_string());
    format!("sainte_devote_{formatted}.zip")
}

fn open_export_file(path: &Path) -> Result<std::fs::File, String> {
    validate::validate_export_path(path)?;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|error| format!("Failed to open export file: {error}"))
}

fn write_zip(path: &Path, tabs: &[ExportTab]) -> Result<(), String> {
    let file = open_export_file(path)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let mut used_names = HashSet::new();

    for (index, tab) in tabs.iter().enumerate() {
        let entry_name = safe_entry_name(&tab.filename, index, &mut used_names);
        zip.start_file(entry_name, options)
            .map_err(|error| format!("Failed to add ZIP entry: {error}"))?;
        zip.write_all(tab.content.as_bytes())
            .map_err(|error| format!("Failed to write ZIP entry: {error}"))?;
    }

    zip.finish()
        .map_err(|error| format!("Failed to finish ZIP export: {error}"))?;
    Ok(())
}

#[tauri::command]
pub async fn export_tabs_data(
    window: WebviewWindow,
    tabs_data: Vec<ExportTab>,
) -> Result<(), String> {
    let file_path = window
        .dialog()
        .file()
        .set_title("Save All Tabs as Zip")
        .set_file_name(default_export_filename())
        .add_filter("Zip Files", &["zip"])
        .blocking_save_file();

    let Some(file_path) = file_path else {
        return Ok(());
    };
    let path = match file_path.into_path() {
        Ok(path) => validate::with_zip_extension(&path),
        Err(error) => {
            let message = format!("Invalid export path: {error}");
            let _ = window.emit("save-file-error", &message);
            return Ok(());
        }
    };

    if let Err(error) = write_zip(&path, &tabs_data) {
        let _ = window.emit("save-file-error", &error);
        return Ok(());
    }

    let Some(path_string) = path.to_str() else {
        let _ = window.emit("save-file-error", "Invalid UTF-8 in export path");
        return Ok(());
    };
    window
        .emit("save-file-success", path_string)
        .map_err(|error| format!("Failed to emit save-file-success: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_names_strip_paths_and_remain_unique() {
        let mut used = HashSet::new();
        assert_eq!(safe_entry_name("../../notes.md", 0, &mut used), "notes.md");
        assert_eq!(safe_entry_name("notes.md", 1, &mut used), "notes_1.md");
        assert_eq!(
            safe_entry_name(r"..\windows\NOTES.MD", 2, &mut used),
            "NOTES_2.MD"
        );
        assert_eq!(safe_entry_name("script.exe", 3, &mut used), "script.exe.md");
        assert_eq!(safe_entry_name("bad\0:name.md", 4, &mut used), "badname.md");
        assert_eq!(safe_entry_name("", 5, &mut used), "tab_6.md");
    }

    // On Unix, resolve symlinks in the temp root (macOS's /tmp is a symlink to
    // /private/tmp, which would trip the path_contains_symlink check). On
    // Windows, std::fs::canonicalize returns a `\\?\` verbatim prefix that the
    // UNC-path guard in validate_export_path rejects, so use the temp dir
    // as-is there.
    fn test_temp_root() -> std::path::PathBuf {
        #[cfg(windows)]
        {
            std::env::temp_dir()
        }
        #[cfg(not(windows))]
        {
            std::fs::canonicalize(std::env::temp_dir()).unwrap()
        }
    }

    #[test]
    fn zip_contains_sanitized_tab_contents() {
        let directory = tempfile::tempdir_in(test_temp_root()).unwrap();
        let path = directory.path().join("tabs.zip");
        let tabs = vec![
            ExportTab {
                filename: "../one.md".to_string(),
                content: "# One".to_string(),
            },
            ExportTab {
                filename: "one.md".to_string(),
                content: "# Two".to_string(),
            },
        ];

        write_zip(&path, &tabs).unwrap();

        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        assert_eq!(archive.len(), 2);
        assert_eq!(archive.by_index(0).unwrap().name(), "one.md");
        assert_eq!(archive.by_index(1).unwrap().name(), "one_1.md");
    }
}
