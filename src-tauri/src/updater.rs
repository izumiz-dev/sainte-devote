use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::oneshot;

use crate::ipc;
use crate::session;
use crate::window_registry::WindowRegistryState;

const REPO_RELEASES_TAG_BASE: &str = "https://github.com/izumiz-dev/sainte-devote/releases/tag";
const DISABLE_AUTO_UPDATE_ENV: &str = "SAINTE_DEVOTE_DISABLE_AUTO_UPDATE";
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);
const PREPARE_INSTALL_TIMEOUT: Duration = Duration::from_millis(1000);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdateInfo {
    pub version: String,
    pub current_version: String,
    pub body: Option<String>,
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateStatus {
    Idle,
    Checking {
        manual: bool,
    },
    #[serde(rename_all = "camelCase")]
    Available {
        #[serde(flatten)]
        info: AvailableUpdateInfo,
        manual: bool,
        dismissed: bool,
    },
    #[serde(rename_all = "camelCase")]
    UpToDate {
        current_version: String,
        manual: bool,
        target_window: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Downloading {
        #[serde(flatten)]
        info: AvailableUpdateInfo,
        downloaded: u64,
        total: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Installing {
        #[serde(flatten)]
        info: AvailableUpdateInfo,
    },
    #[serde(rename_all = "camelCase")]
    Error {
        message: String,
        manual: bool,
        available: Option<AvailableUpdateInfo>,
        target_window: Option<String>,
    },
}

struct PendingPrepare {
    pending_windows: HashSet<String>,
    unsaved_tabs: Vec<String>,
    done: Option<oneshot::Sender<Vec<String>>>,
}

struct UpdaterInner {
    status: UpdateStatus,
    pending_update: Option<Update>,
    pending_info: Option<AvailableUpdateInfo>,
    startup_checked: bool,
    prepares: HashMap<u64, PendingPrepare>,
}

pub struct UpdaterState {
    inner: Mutex<UpdaterInner>,
    is_restarting: AtomicBool,
    next_prepare_id: AtomicU64,
}

impl Default for UpdaterState {
    fn default() -> Self {
        Self::new()
    }
}

impl UpdaterState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(UpdaterInner {
                status: UpdateStatus::Idle,
                pending_update: None,
                pending_info: None,
                startup_checked: false,
                prepares: HashMap::new(),
            }),
            is_restarting: AtomicBool::new(false),
            next_prepare_id: AtomicU64::new(1),
        }
    }

    pub fn is_restarting(&self) -> bool {
        self.is_restarting.load(Ordering::SeqCst)
    }

    pub fn set_restarting(&self, restarting: bool) {
        self.is_restarting.store(restarting, Ordering::SeqCst);
    }

    pub fn status(&self) -> UpdateStatus {
        self.inner
            .lock()
            .expect("updater state mutex poisoned")
            .status
            .clone()
    }

    pub fn mark_startup_checked(&self) -> bool {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        if inner.startup_checked {
            return false;
        }
        inner.startup_checked = true;
        true
    }

    fn try_begin_check(&self, manual: bool) -> Option<UpdateStatus> {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        if matches!(
            inner.status,
            UpdateStatus::Checking { .. }
                | UpdateStatus::Downloading { .. }
                | UpdateStatus::Installing { .. }
        ) {
            return Some(inner.status.clone());
        }
        inner.status = UpdateStatus::Checking { manual };
        None
    }

    fn set_status(&self, status: UpdateStatus) {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        if !matches!(status, UpdateStatus::Available { .. }) {
            inner.pending_update = None;
            inner.pending_info = None;
        }
        inner.status = status;
    }

    fn set_available(
        &self,
        update: Update,
        info: AvailableUpdateInfo,
        manual: bool,
    ) -> UpdateStatus {
        let status = UpdateStatus::Available {
            info: info.clone(),
            manual,
            dismissed: false,
        };
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner.pending_update = Some(update);
        inner.pending_info = Some(info);
        inner.status = status.clone();
        status
    }

    fn dismiss_available(&self) -> Option<UpdateStatus> {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        match &inner.status {
            UpdateStatus::Available { info, manual, .. } => {
                let updated = UpdateStatus::Available {
                    info: info.clone(),
                    manual: *manual,
                    dismissed: true,
                };
                inner.status = updated.clone();
                Some(updated)
            }
            UpdateStatus::Error {
                available: Some(info),
                ..
            } => {
                let updated = UpdateStatus::Available {
                    info: info.clone(),
                    manual: false,
                    dismissed: true,
                };
                inner.status = updated.clone();
                Some(updated)
            }
            _ => None,
        }
    }

    fn try_begin_install(&self) -> Result<(Update, AvailableUpdateInfo), String> {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        if matches!(
            inner.status,
            UpdateStatus::Downloading { .. } | UpdateStatus::Installing { .. }
        ) {
            return Err("An update installation is already in progress.".to_string());
        }
        let Some(update) = inner.pending_update.take() else {
            return Err("No pending update is available to install.".to_string());
        };
        let info = inner
            .pending_info
            .clone()
            .unwrap_or_else(|| AvailableUpdateInfo {
                release_url: release_notes_url(&update.version),
                version: update.version.clone(),
                current_version: update.current_version.clone(),
                body: update.body.clone(),
            });
        inner.status = UpdateStatus::Downloading {
            info: info.clone(),
            downloaded: 0,
            total: None,
        };
        Ok((update, info))
    }

    fn update_download_progress(
        &self,
        info: &AvailableUpdateInfo,
        downloaded: u64,
        total: Option<u64>,
    ) {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner.status = UpdateStatus::Downloading {
            info: info.clone(),
            downloaded,
            total,
        };
    }

    fn set_installing(&self, info: &AvailableUpdateInfo) -> UpdateStatus {
        let status = UpdateStatus::Installing { info: info.clone() };
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner.status = status.clone();
        status
    }

    fn restore_available_after_error(
        &self,
        update: Update,
        info: AvailableUpdateInfo,
        message: String,
        target_window: Option<String>,
    ) -> UpdateStatus {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner.pending_update = Some(update);
        inner.pending_info = Some(info.clone());
        let status = UpdateStatus::Error {
            message,
            manual: true,
            available: Some(info),
            target_window,
        };
        inner.status = status.clone();
        status
    }

    fn begin_prepare(&self, windows: Vec<String>) -> (u64, oneshot::Receiver<Vec<String>>) {
        let request_id = self.next_prepare_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        let pending_windows: HashSet<String> = windows.into_iter().collect();
        if pending_windows.is_empty() {
            let _ = tx.send(Vec::new());
            return (request_id, rx);
        }
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner.prepares.insert(
            request_id,
            PendingPrepare {
                pending_windows,
                unsaved_tabs: Vec::new(),
                done: Some(tx),
            },
        );
        (request_id, rx)
    }

    fn record_prepare_response(&self, request_id: u64, label: &str, unsaved_tabs: Vec<String>) {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        let Some(entry) = inner.prepares.get_mut(&request_id) else {
            return;
        };
        if entry.pending_windows.remove(label) {
            entry.unsaved_tabs.extend(unsaved_tabs);
        }
        if entry.pending_windows.is_empty() {
            if let Some(mut finished) = inner.prepares.remove(&request_id) {
                if let Some(tx) = finished.done.take() {
                    let _ = tx.send(finished.unsaved_tabs);
                }
            }
        }
    }

    fn finish_prepare_timeout(&self, request_id: u64) -> Vec<String> {
        let mut inner = self.inner.lock().expect("updater state mutex poisoned");
        inner
            .prepares
            .remove(&request_id)
            .map(|entry| entry.unsaved_tabs)
            .unwrap_or_default()
    }
}

pub fn release_notes_url(version: &str) -> String {
    let trimmed = version.trim();
    let tag = if trimmed.starts_with('v') {
        trimmed.to_string()
    } else {
        format!("v{trimmed}")
    };
    let mut url =
        url::Url::parse(REPO_RELEASES_TAG_BASE).expect("static release tag base URL must be valid");
    if let Ok(mut segments) = url.path_segments_mut() {
        segments.push(&tag);
    }
    url.into()
}

fn is_auto_update_disabled() -> bool {
    std::env::var(DISABLE_AUTO_UPDATE_ENV)
        .ok()
        .is_some_and(|value| {
            let trimmed = value.trim();
            trimmed == "1" || trimmed.eq_ignore_ascii_case("true")
        })
}

fn has_configured_pubkey<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

fn broadcast_status<R: Runtime>(app: &AppHandle<R>, status: &UpdateStatus) {
    ipc::emit_to_all_windows(app, "update-status", status.clone());
}

fn show_windowless_dialog<R: Runtime>(app: &AppHandle<R>, message: String) {
    app.dialog()
        .message(message)
        .title("Sainte Devote")
        .show(|_| {});
}

async fn run_check<R: Runtime>(
    app: AppHandle<R>,
    manual: bool,
    target_window: Option<String>,
) -> UpdateStatus {
    let state = app.state::<UpdaterState>();

    if !manual
        && (cfg!(debug_assertions) || is_auto_update_disabled() || !state.mark_startup_checked())
    {
        return state.status();
    }

    if !has_configured_pubkey(&app) {
        if !manual {
            return UpdateStatus::Idle;
        }
        let message = "Auto-update signing key is not configured in this build.".to_string();
        let status = UpdateStatus::Error {
            message: message.clone(),
            manual,
            available: None,
            target_window,
        };
        state.set_status(status.clone());
        if app.webview_windows().is_empty() {
            show_windowless_dialog(&app, message);
        } else {
            broadcast_status(&app, &status);
        }
        return status;
    }

    if let Some(in_progress) = state.try_begin_check(manual) {
        return in_progress;
    }

    if manual {
        broadcast_status(&app, &UpdateStatus::Checking { manual });
    }

    let current_version = app.package_info().version.to_string();
    let check_result = match app.updater() {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };

    match check_result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            let info = AvailableUpdateInfo {
                release_url: release_notes_url(&version),
                version,
                current_version: update.current_version.clone(),
                body: update.body.clone(),
            };
            let status = state.set_available(update, info, manual);
            if app.webview_windows().is_empty() {
                if manual {
                    session::spawn_editor_window(app.clone(), None);
                }
            } else {
                broadcast_status(&app, &status);
            }
            status
        }
        Ok(None) => {
            let status = UpdateStatus::UpToDate {
                current_version: current_version.clone(),
                manual,
                target_window,
            };
            state.set_status(status.clone());
            if app.webview_windows().is_empty() {
                if manual {
                    show_windowless_dialog(
                        &app,
                        format!("You're up to date (v{current_version})."),
                    );
                }
            } else {
                broadcast_status(&app, &status);
            }
            status
        }
        Err(error) => {
            if manual {
                let message = format!("Failed to check for updates: {error}");
                let status = UpdateStatus::Error {
                    message: message.clone(),
                    manual: true,
                    available: None,
                    target_window,
                };
                state.set_status(status.clone());
                if app.webview_windows().is_empty() {
                    show_windowless_dialog(&app, message);
                } else {
                    broadcast_status(&app, &status);
                }
                status
            } else {
                state.set_status(UpdateStatus::Idle);
                broadcast_status(&app, &UpdateStatus::Idle);
                UpdateStatus::Idle
            }
        }
    }
}

pub fn trigger_manual_check<R: Runtime>(app: AppHandle<R>) {
    let target_window = app.state::<WindowRegistryState>().lock().menu_target();
    tauri::async_runtime::spawn(async move {
        let _ = run_check(app, true, target_window).await;
    });
}

#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    window: WebviewWindow,
    manual: bool,
) -> Result<UpdateStatus, String> {
    let target = if manual {
        Some(window.label().to_string())
    } else {
        None
    };
    Ok(run_check(app, manual, target).await)
}

#[tauri::command]
pub fn dismiss_update(app: AppHandle, state: State<'_, UpdaterState>) {
    if let Some(status) = state.dismiss_available() {
        broadcast_status(&app, &status);
    }
}

#[tauri::command]
pub async fn prepare_update_install(app: AppHandle) -> Result<Vec<String>, String> {
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    let state = app.state::<UpdaterState>();
    let (request_id, rx) = state.begin_prepare(labels);
    ipc::emit_to_all_windows(
        &app,
        "update-prepare-install",
        serde_json::json!({ "requestId": request_id }),
    );
    match tokio::time::timeout(PREPARE_INSTALL_TIMEOUT, rx).await {
        Ok(Ok(unsaved)) => Ok(unsaved),
        Ok(Err(_)) | Err(_) => Ok(state.finish_prepare_timeout(request_id)),
    }
}

#[tauri::command]
pub fn report_update_prepare(
    window: WebviewWindow,
    state: State<'_, UpdaterState>,
    request_id: u64,
    unsaved_tabs: Vec<String>,
) {
    state.record_prepare_response(request_id, window.label(), unsaved_tabs);
}

#[tauri::command]
pub async fn install_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let target_window = Some(window.label().to_string());
    let state = app.state::<UpdaterState>();
    let (update, info) = match state.try_begin_install() {
        Ok(pair) => pair,
        Err(message) => {
            let available = state
                .inner
                .lock()
                .expect("updater state mutex poisoned")
                .pending_info
                .clone();
            let status = UpdateStatus::Error {
                message,
                manual: true,
                available,
                target_window,
            };
            broadcast_status(&app, &status);
            return Ok(());
        }
    };

    let initial = UpdateStatus::Downloading {
        info: info.clone(),
        downloaded: 0,
        total: None,
    };
    broadcast_status(&app, &initial);

    let mut downloaded_total: u64 = 0;
    let mut last_emit = Instant::now() - PROGRESS_EMIT_INTERVAL;
    let app_for_progress = app.clone();
    let info_for_progress = info.clone();

    let downloaded_bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded_total = downloaded_total.saturating_add(chunk_length as u64);
                let now = Instant::now();
                let is_complete = content_length.is_some_and(|total| downloaded_total >= total);
                if is_complete || now.duration_since(last_emit) >= PROGRESS_EMIT_INTERVAL {
                    last_emit = now;
                    let progress = UpdateStatus::Downloading {
                        info: info_for_progress.clone(),
                        downloaded: downloaded_total,
                        total: content_length,
                    };
                    app_for_progress
                        .state::<UpdaterState>()
                        .update_download_progress(
                            &info_for_progress,
                            downloaded_total,
                            content_length,
                        );
                    broadcast_status(&app_for_progress, &progress);
                }
            },
            || {},
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            let message = format!("Failed to download update: {error}");
            let status = state.restore_available_after_error(update, info, message, target_window);
            broadcast_status(&app, &status);
            return Ok(());
        }
    };

    let installing = state.set_installing(&info);
    broadcast_status(&app, &installing);
    state.set_restarting(true);

    let install_outcome = tauri::async_runtime::spawn_blocking(move || {
        let res = update.install(downloaded_bytes);
        (update, res)
    })
    .await;

    match install_outcome {
        Ok((_update, Ok(()))) => {
            app.request_restart();
            Ok(())
        }
        Ok((update, Err(error))) => {
            state.set_restarting(false);
            let message = format!("Failed to install update: {error}");
            let status = state.restore_available_after_error(update, info, message, target_window);
            broadcast_status(&app, &status);
            Ok(())
        }
        Err(join_error) => {
            state.set_restarting(false);
            let message = format!("Failed to install update: {join_error}");
            let status = UpdateStatus::Error {
                message,
                manual: true,
                available: None,
                target_window,
            };
            state.set_status(status.clone());
            broadcast_status(&app, &status);
            Ok(())
        }
    }
}

#[tauri::command]
pub fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn get_update_status(state: State<'_, UpdaterState>) -> UpdateStatus {
    state.status()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_notes_url_normalizes_v_prefix_and_encodes_segments() {
        assert_eq!(
            release_notes_url("2.3.0"),
            "https://github.com/izumiz-dev/sainte-devote/releases/tag/v2.3.0"
        );
        assert_eq!(
            release_notes_url("v2.3.0"),
            "https://github.com/izumiz-dev/sainte-devote/releases/tag/v2.3.0"
        );
        assert_eq!(
            release_notes_url("2.3.0/../../evil"),
            "https://github.com/izumiz-dev/sainte-devote/releases/tag/v2.3.0%2F..%2F..%2Fevil"
        );
    }

    #[test]
    fn updater_state_guards_concurrent_checks_and_startup_once() {
        let state = UpdaterState::new();
        assert_eq!(state.status(), UpdateStatus::Idle);
        assert!(state.mark_startup_checked());
        assert!(!state.mark_startup_checked());

        assert!(state.try_begin_check(true).is_none());
        assert_eq!(
            state.try_begin_check(true),
            Some(UpdateStatus::Checking { manual: true })
        );

        state.set_status(UpdateStatus::UpToDate {
            current_version: "2.2.2".to_string(),
            manual: true,
            target_window: None,
        });
        assert!(state.try_begin_check(false).is_none());
    }

    #[test]
    fn install_requires_pending_update_and_restarting_flag_toggles() {
        let state = UpdaterState::new();
        assert!(!state.is_restarting());
        assert!(state.try_begin_install().is_err());

        state.set_restarting(true);
        assert!(state.is_restarting());
    }

    #[test]
    fn prepare_collects_responses_from_every_window() {
        let state = UpdaterState::new();
        let (request_id, mut rx) =
            state.begin_prepare(vec!["main".to_string(), "editor-1".to_string()]);
        state.record_prepare_response(request_id, "main", vec!["notes.md".to_string()]);
        assert!(rx.try_recv().is_err());

        state.record_prepare_response(request_id, "editor-1", vec!["draft.md".to_string()]);
        let unsaved = rx.try_recv().expect("all windows responded");
        assert_eq!(
            unsaved,
            vec!["notes.md".to_string(), "draft.md".to_string()]
        );
    }
}
