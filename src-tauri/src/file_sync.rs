use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::files;

const CHANGE_CHECK_DEBOUNCE: Duration = Duration::from_millis(200);
const CHANGE_CHECK_RETRY_DELAY: Duration = Duration::from_millis(100);
const MAX_READ_RETRIES: u8 = 2;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalFileChangedPayload {
    file_path: String,
    content: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalFileRemovedPayload {
    file_path: String,
}

enum WorkerMessage {
    WatchFile { path: PathBuf, hash: [u8; 32] },
    RememberContent { path: PathBuf, hash: [u8; 32] },
    UnwatchFile { path: PathBuf },
    RecheckAll,
    StopAll,
    NotifyEvent(notify::Result<notify::Event>),
    Shutdown,
}

struct WatchedFile {
    parent: PathBuf,
    last_hash: Option<[u8; 32]>,
}

struct WatchedDirectory {
    file_count: usize,
    installed: bool,
}

struct PendingCheck {
    due: Instant,
    attempt: u8,
}

pub struct ExternalFileSyncState {
    tx: Sender<WorkerMessage>,
    worker: Mutex<Option<JoinHandle<()>>>,
    shutting_down: AtomicBool,
}

impl ExternalFileSyncState {
    pub fn spawn(app: AppHandle) -> Result<Self, String> {
        let (tx, rx) = mpsc::channel();
        let event_tx = tx.clone();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = event_tx.send(WorkerMessage::NotifyEvent(event));
        })
        .map_err(|e| format!("Failed to create file watcher: {e}"))?;

        let worker = std::thread::Builder::new()
            .name("external-file-sync".to_string())
            .spawn(move || WatchWorker::new(app, watcher).run(rx))
            .map_err(|e| format!("Failed to start file watcher thread: {e}"))?;

        Ok(Self {
            tx,
            worker: Mutex::new(Some(worker)),
            shutting_down: AtomicBool::new(false),
        })
    }

    pub fn watch_file(&self, path: &Path, content: &str) {
        let _ = self.tx.send(WorkerMessage::WatchFile {
            path: path.to_path_buf(),
            hash: hash_content(content),
        });
    }

    pub fn remember_content(&self, path: &Path, content: &str) {
        let _ = self.tx.send(WorkerMessage::RememberContent {
            path: path.to_path_buf(),
            hash: hash_content(content),
        });
    }

    pub fn unwatch_file(&self, path: &Path) {
        let _ = self.tx.send(WorkerMessage::UnwatchFile {
            path: path.to_path_buf(),
        });
    }

    pub fn recheck_all(&self) {
        let _ = self.tx.send(WorkerMessage::RecheckAll);
    }

    pub fn stop_all(&self) {
        let _ = self.tx.send(WorkerMessage::StopAll);
    }

    pub fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.tx.send(WorkerMessage::Shutdown);
        if let Some(worker) = self.worker.lock().unwrap().take() {
            let _ = worker.join();
        }
    }
}

struct WatchWorker {
    app: AppHandle,
    watcher: RecommendedWatcher,
    files: HashMap<PathBuf, WatchedFile>,
    directories: HashMap<PathBuf, WatchedDirectory>,
    pending: HashMap<PathBuf, PendingCheck>,
}

impl WatchWorker {
    fn new(app: AppHandle, watcher: RecommendedWatcher) -> Self {
        Self {
            app,
            watcher,
            files: HashMap::new(),
            directories: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    fn run(mut self, rx: Receiver<WorkerMessage>) {
        loop {
            let message = match self.next_timeout() {
                Some(timeout) => match rx.recv_timeout(timeout) {
                    Ok(message) => Some(message),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                },
                None => match rx.recv() {
                    Ok(message) => Some(message),
                    Err(_) => break,
                },
            };

            if let Some(message) = message {
                if self.handle_message(message) {
                    break;
                }
            }
            self.process_due_checks();
        }
        self.stop_all();
    }

    fn next_timeout(&self) -> Option<Duration> {
        self.pending
            .values()
            .map(|pending| pending.due.saturating_duration_since(Instant::now()))
            .min()
    }

    fn handle_message(&mut self, message: WorkerMessage) -> bool {
        match message {
            WorkerMessage::WatchFile { path, hash } => self.watch_file(path, hash),
            WorkerMessage::RememberContent { path, hash } => {
                if let Some(file) = self.files.get_mut(&path) {
                    file.last_hash = Some(hash);
                }
            }
            WorkerMessage::UnwatchFile { path } => self.unwatch_file(&path),
            WorkerMessage::RecheckAll => self.recheck_all(),
            WorkerMessage::StopAll => self.stop_all(),
            WorkerMessage::NotifyEvent(event) => self.handle_notify_event(event),
            WorkerMessage::Shutdown => return true,
        }
        false
    }

    fn watch_file(&mut self, path: PathBuf, hash: [u8; 32]) {
        if let Some(file) = self.files.get_mut(&path) {
            file.last_hash = Some(hash);
            return;
        }

        let Some(parent) = path.parent().map(Path::to_path_buf) else {
            return;
        };
        let directory =
            self.directories
                .entry(parent.clone())
                .or_insert_with(|| WatchedDirectory {
                    file_count: 0,
                    installed: false,
                });
        directory.file_count += 1;
        if !directory.installed {
            match self.watcher.watch(&parent, RecursiveMode::NonRecursive) {
                Ok(()) => directory.installed = true,
                Err(e) => eprintln!("failed to watch {}: {e}", parent.display()),
            }
        }

        self.files.insert(
            path,
            WatchedFile {
                parent,
                last_hash: Some(hash),
            },
        );
    }

    fn unwatch_file(&mut self, path: &Path) {
        self.pending.remove(path);
        let Some(file) = self.files.remove(path) else {
            return;
        };
        let should_remove_directory =
            if let Some(directory) = self.directories.get_mut(&file.parent) {
                directory.file_count = directory.file_count.saturating_sub(1);
                directory.file_count == 0
            } else {
                false
            };
        if should_remove_directory {
            if self
                .directories
                .get(&file.parent)
                .is_some_and(|directory| directory.installed)
            {
                let _ = self.watcher.unwatch(&file.parent);
            }
            self.directories.remove(&file.parent);
        }
    }

    fn recheck_all(&mut self) {
        let retry_directories: Vec<PathBuf> = self
            .directories
            .iter()
            .filter(|(_, directory)| !directory.installed)
            .map(|(path, _)| path.clone())
            .collect();
        for directory_path in retry_directories {
            if self
                .watcher
                .watch(&directory_path, RecursiveMode::NonRecursive)
                .is_ok()
            {
                if let Some(directory) = self.directories.get_mut(&directory_path) {
                    directory.installed = true;
                }
            }
        }
        self.schedule_paths(self.files.keys().cloned().collect());
    }

    fn stop_all(&mut self) {
        let installed_directories: Vec<PathBuf> = self
            .directories
            .iter()
            .filter(|(_, directory)| directory.installed)
            .map(|(path, _)| path.clone())
            .collect();
        for directory in installed_directories {
            let _ = self.watcher.unwatch(&directory);
        }
        self.pending.clear();
        self.files.clear();
        self.directories.clear();
    }

    fn handle_notify_event(&mut self, event: notify::Result<notify::Event>) {
        let event = match event {
            Ok(event) => event,
            Err(e) => {
                eprintln!("external file watcher error: {e}");
                self.schedule_paths(self.files.keys().cloned().collect());
                return;
            }
        };

        if event.paths.is_empty() {
            self.schedule_paths(self.files.keys().cloned().collect());
            return;
        }

        let mut paths = Vec::new();
        for (path, file) in &self.files {
            if event.paths.iter().any(|event_path| {
                event_path == path
                    || event_path == &file.parent
                    || event_path.parent() == Some(file.parent.as_path())
            }) {
                paths.push(path.clone());
            }
        }
        self.schedule_paths(paths);
    }

    fn schedule_paths(&mut self, paths: Vec<PathBuf>) {
        let due = Instant::now() + CHANGE_CHECK_DEBOUNCE;
        for path in paths {
            if self.files.contains_key(&path) {
                self.pending.insert(path, PendingCheck { due, attempt: 0 });
            }
        }
    }

    fn process_due_checks(&mut self) {
        let now = Instant::now();
        let due: Vec<(PathBuf, u8)> = self
            .pending
            .iter()
            .filter(|(_, pending)| pending.due <= now)
            .map(|(path, pending)| (path.clone(), pending.attempt))
            .collect();
        for (path, attempt) in due {
            self.pending.remove(&path);
            self.check_file(path, attempt);
        }
    }

    fn check_file(&mut self, path: PathBuf, attempt: u8) {
        if !self.files.contains_key(&path) {
            return;
        }

        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                self.emit_removed_if_needed(&path);
                return;
            }
            Err(e) => {
                self.retry_or_log(path, attempt, format!("Failed to inspect file: {e}"));
                return;
            }
            Ok(metadata)
                if !metadata.file_type().is_file() || metadata.file_type().is_symlink() =>
            {
                eprintln!("external file replacement rejected: {}", path.display());
                return;
            }
            Ok(_) => {}
        }

        let content = match files::read_file_content(&path) {
            Ok(content) => content,
            Err(e) => {
                if !path.exists() {
                    self.emit_removed_if_needed(&path);
                } else {
                    self.retry_or_log(path, attempt, e);
                }
                return;
            }
        };
        let new_hash = hash_content(&content);
        let changed = self
            .files
            .get(&path)
            .is_some_and(|file| file.last_hash != Some(new_hash));
        if !changed {
            return;
        }
        if let Some(file) = self.files.get_mut(&path) {
            file.last_hash = Some(new_hash);
        }
        self.emit_changed(&path, content);
    }

    fn retry_or_log(&mut self, path: PathBuf, attempt: u8, error: String) {
        if attempt < MAX_READ_RETRIES {
            self.pending.insert(
                path,
                PendingCheck {
                    due: Instant::now() + CHANGE_CHECK_RETRY_DELAY,
                    attempt: attempt + 1,
                },
            );
        } else {
            eprintln!("external file check failed for {}: {error}", path.display());
        }
    }

    fn emit_removed_if_needed(&mut self, path: &Path) {
        let should_emit = self
            .files
            .get(path)
            .is_some_and(|file| file.last_hash.is_some());
        if !should_emit {
            return;
        }
        if let Some(file) = self.files.get_mut(path) {
            file.last_hash = None;
        }
        let Some(file_path) = path.to_str() else {
            return;
        };
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.emit(
                "file-removed-externally",
                ExternalFileRemovedPayload {
                    file_path: file_path.to_string(),
                },
            );
        }
    }

    fn emit_changed(&self, path: &Path, content: String) {
        let Some(file_path) = path.to_str() else {
            return;
        };
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.emit(
                "file-changed-externally",
                ExternalFileChangedPayload {
                    file_path: file_path.to_string(),
                    content,
                },
            );
        }
    }
}

fn hash_content(content: &str) -> [u8; 32] {
    Sha256::digest(content.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_hash_is_stable_and_sensitive_to_changes() {
        assert_eq!(hash_content("same"), hash_content("same"));
        assert_ne!(hash_content("same"), hash_content("changed"));
    }

    #[test]
    fn content_hash_matches_known_sha256_vector() {
        assert_eq!(
            hash_content("abc"),
            [
                0xba, 0x78, 0x16, 0xbf, 0x8f, 0x01, 0xcf, 0xea, 0x41, 0x41, 0x40, 0xde, 0x5d, 0xae,
                0x22, 0x23, 0xb0, 0x03, 0x61, 0xa3, 0x96, 0x17, 0x7a, 0x9c, 0xb4, 0x10, 0xff, 0x61,
                0xf2, 0x00, 0x15, 0xad,
            ]
        );
    }
}
