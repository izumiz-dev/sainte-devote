use std::fs::{File, OpenOptions};
use std::path::Path;

/// Open `path` for reading without following a symlink / name-surrogate
/// reparse point at the final component (Unix `O_NOFOLLOW`, Windows
/// `FILE_FLAG_OPEN_REPARSE_POINT` plus a reparse-tag check).
pub fn open_read_nofollow(path: &Path) -> Result<File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| format!("Failed to open file (O_NOFOLLOW): {error}"))
    }

    #[cfg(windows)]
    {
        open_windows(path, WindowsAccess::Read)
    }

    #[cfg(not(any(unix, windows)))]
    {
        OpenOptions::new()
            .read(true)
            .open(path)
            .map_err(|error| format!("Failed to open file: {error}"))
    }
}

/// Open `path` for writing (create + truncate) without following a symlink /
/// name-surrogate reparse point at the final component.
pub fn open_write_nofollow(path: &Path) -> Result<File, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)
            .map_err(|error| format!("Failed to write file (O_NOFOLLOW): {error}"))
    }

    #[cfg(windows)]
    {
        open_windows(path, WindowsAccess::Write)
    }

    #[cfg(not(any(unix, windows)))]
    {
        OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|error| format!("Failed to write file: {error}"))
    }
}

#[cfg(windows)]
enum WindowsAccess {
    Read,
    Write,
}

#[cfg(windows)]
fn open_windows(path: &Path, access: WindowsAccess) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;

    // Do not truncate until the handle is confirmed not to be a name-surrogate
    // reparse point; truncate-on-open would clobber a symlink/junction.
    let mut options = OpenOptions::new();
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    match access {
        WindowsAccess::Read => {
            options.read(true);
        }
        WindowsAccess::Write => {
            // FILE_READ_ATTRIBUTES is required for FileAttributeTagInfo.
            options.read(true).write(true).create(true);
        }
    }

    let file = options
        .open(path)
        .map_err(|error| format!("Failed to open file (reparse-safe): {error}"))?;

    match reparse_kind(&file)? {
        ReparseKind::NameSurrogate => {
            Err("Refusing to follow a symbolic link or junction".to_string())
        }
        ReparseKind::Other => {
            // Non-surrogate reparse (e.g. OneDrive placeholder): reopen without
            // FILE_FLAG_OPEN_REPARSE_POINT so the filter can hydrate content.
            drop(file);
            if std::fs::symlink_metadata(path)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(true)
            {
                return Err("Refusing to follow a symbolic link or junction".to_string());
            }
            let mut hydrated = OpenOptions::new();
            match access {
                WindowsAccess::Read => {
                    hydrated.read(true);
                }
                WindowsAccess::Write => {
                    hydrated.write(true).create(true).truncate(true);
                }
            }
            hydrated
                .open(path)
                .map_err(|error| format!("Failed to open file: {error}"))
        }
        ReparseKind::None => {
            if matches!(access, WindowsAccess::Write) {
                file.set_len(0)
                    .map_err(|error| format!("Failed to truncate file: {error}"))?;
            }
            Ok(file)
        }
    }
}

#[cfg(windows)]
#[derive(Debug, PartialEq, Eq)]
enum ReparseKind {
    None,
    NameSurrogate,
    Other,
}

#[cfg(windows)]
const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
#[cfg(windows)]
const IO_REPARSE_TAG_NAME_SURROGATE: u32 = 0x2000_0000;
#[cfg(windows)]
const FILE_ATTRIBUTE_TAG_INFO_CLASS: i32 = 9;

#[cfg(windows)]
#[repr(C)]
struct FileAttributeTagInfo {
    file_attributes: u32,
    reparse_tag: u32,
}

#[cfg(windows)]
fn reparse_kind(file: &File) -> Result<ReparseKind, String> {
    use std::os::windows::fs::MetadataExt;
    use std::os::windows::io::AsRawHandle;

    let mut info = FileAttributeTagInfo {
        file_attributes: 0,
        reparse_tag: 0,
    };
    // SAFETY: `file` is an open handle; `info` matches FILE_ATTRIBUTE_TAG_INFO
    // (class 9) in size and layout.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            std::ptr::from_mut(&mut info).cast(),
            std::mem::size_of::<FileAttributeTagInfo>() as u32,
        )
    };
    if ok == 0 {
        // Some volumes do not implement FileAttributeTagInfo. Fall back to the
        // handle attributes: refuse any reparse point (fail closed) and allow
        // regular files.
        let attributes = file
            .metadata()
            .map_err(|error| format!("Failed to inspect file: {error}"))?
            .file_attributes();
        return if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            Ok(ReparseKind::NameSurrogate)
        } else {
            Ok(ReparseKind::None)
        };
    }

    if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
        return Ok(ReparseKind::None);
    }
    if info.reparse_tag & IO_REPARSE_TAG_NAME_SURROGATE != 0 {
        Ok(ReparseKind::NameSurrogate)
    } else {
        Ok(ReparseKind::Other)
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetFileInformationByHandleEx(
        hfile: std::os::windows::io::RawHandle,
        class: i32,
        info: *mut core::ffi::c_void,
        size: u32,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Read, Write};

    fn try_symlink_file(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    #[test]
    fn write_then_read_regular_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("note.md");

        let mut file = open_write_nofollow(&path).unwrap();
        file.write_all(b"hello").unwrap();
        drop(file);

        let mut file = open_read_nofollow(&path).unwrap();
        let mut body = String::new();
        file.read_to_string(&mut body).unwrap();
        assert_eq!(body, "hello");
    }

    #[test]
    fn read_rejects_leaf_symlink() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("link.md");
        fs::write(&target, "secret").unwrap();
        if !try_symlink_file(&target, &link) {
            return;
        }

        let error = open_read_nofollow(&link).unwrap_err();
        assert!(
            error.contains("O_NOFOLLOW")
                || error.contains("symbolic link or junction")
                || error.contains("reparse-safe"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
    }

    #[test]
    fn write_rejects_leaf_symlink_without_clobbering_target() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("target.md");
        let link = directory.path().join("link.md");
        fs::write(&target, "secret").unwrap();
        if !try_symlink_file(&target, &link) {
            return;
        }

        let error = open_write_nofollow(&link).unwrap_err();
        assert!(
            error.contains("O_NOFOLLOW")
                || error.contains("symbolic link or junction")
                || error.contains("reparse-safe"),
            "unexpected error: {error}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), "secret");
    }
}
