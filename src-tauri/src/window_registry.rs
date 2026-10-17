use serde::Serialize;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_WINDOWS: usize = 32;
pub const MAX_CLAIM_IDS: usize = 64;
pub const MAIN_LABEL: &str = "main";
/// How long a recorded hand-off merge blocks a racing detach request for the
/// same (source window, tab id) pair.
pub const TAB_DRAG_MERGE_GRACE: Duration = Duration::from_secs(2);

pub type WindowLabel = String;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowRole {
    Primary,
    New,
}

impl WindowRole {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Primary => "primary",
            Self::New => "new",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingOpen {
    pub path: PathBuf,
    pub grant_write: bool,
}

/// A scratch tab handed to a window that is still booting (tab dragged out of
/// another window). Delivered after `renderer-ready`.
///
/// `tab_id` / `origin_workspace_id` identify the tab in the source window so
/// the target can record the handoff origin (used to detect crash-orphaned
/// source copies at the next startup).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTab {
    pub tab_id: i64,
    pub origin_workspace_id: Option<String>,
    pub title: String,
    pub content: String,
}

/// A tab currently being dragged somewhere in the app. Only one pointer exists
/// at a time, so a single slot is enough: the renderer registers the payload
/// on `dragstart`, and whichever window receives the native drop consumes it.
///
/// `tab_id` is echoed back to the source window (`tab-drag-consumed` /
/// `tab-dropped-outside`), so the source removes the right tab even when its
/// own drag state was already cleared by a racing dragend.
/// `origin_workspace_id` names the scratch workspace the tab comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TabDrag {
    pub source: WindowLabel,
    pub tab_id: i64,
    pub origin_workspace_id: Option<String>,
    pub title: String,
    pub content: String,
    pub file_path: Option<String>,
}

#[derive(Clone, Debug)]
pub struct WindowEntry {
    pub role: WindowRole,
    pub workspace_id: Option<String>,
    pub renderer_ready: bool,
    pub pending_opens: Vec<PendingOpen>,
    pub pending_tabs: Vec<PendingTab>,
    pub close_pending: bool,
    pub closing: bool,
}

impl WindowEntry {
    fn new(role: WindowRole) -> Self {
        Self {
            role,
            workspace_id: None,
            renderer_ready: false,
            pending_opens: Vec::new(),
            pending_tabs: Vec::new(),
            close_pending: false,
            closing: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoutedOpen {
    pub target: WindowLabel,
    pub grant_write: bool,
    pub queued: bool,
    pub transferred: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyFlush {
    pub pending: Vec<PendingOpen>,
    pub tabs: Vec<PendingTab>,
    pub reset_session: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseRequestOutcome {
    Allow,
    PreventAndAsk,
}

#[derive(Debug)]
pub struct WindowRegistry {
    next_editor_id: u32,
    windows: HashMap<WindowLabel, WindowEntry>,
    focus_mru: Vec<WindowLabel>,
    owners: HashMap<PathBuf, WindowLabel>,
    claims: HashMap<String, WindowLabel>,
    drag: Option<TabDrag>,
    /// Last hand-off merge performed for a (source window, tab id) pair, so a
    /// detach fallback racing the `tab-drag-consumed` event cannot spawn a
    /// duplicate window holding the same tab.
    recent_merge: Option<(WindowLabel, i64, Instant)>,
}

impl WindowRegistry {
    pub fn new() -> Self {
        let mut registry = Self {
            next_editor_id: 1,
            windows: HashMap::new(),
            focus_mru: Vec::new(),
            owners: HashMap::new(),
            claims: HashMap::new(),
            drag: None,
            recent_merge: None,
        };
        registry.windows.insert(
            MAIN_LABEL.to_string(),
            WindowEntry::new(WindowRole::Primary),
        );
        registry
    }

    pub fn allocate_editor(&mut self) -> Result<WindowLabel, &'static str> {
        if self.windows.len() >= MAX_WINDOWS {
            return Err("window limit reached");
        }
        let id = self.next_editor_id;
        self.next_editor_id = self.next_editor_id.saturating_add(1);
        let label = format!("editor-{id}");
        self.windows
            .insert(label.clone(), WindowEntry::new(WindowRole::New));
        Ok(label)
    }

    pub fn destroy_window(&mut self, label: &str) {
        self.windows.remove(label);
        self.focus_mru.retain(|item| item != label);
        self.owners.retain(|_, owner| owner != label);
        self.claims.retain(|_, owner| owner != label);
        self.clear_tab_drag(label);
    }

    pub fn note_focus(&mut self, label: &str) {
        if !self.windows.contains_key(label) {
            return;
        }
        self.focus_mru.retain(|item| item != label);
        self.focus_mru.insert(0, label.to_string());
    }

    pub fn menu_target(&self) -> Option<WindowLabel> {
        self.focus_mru
            .iter()
            .find(|label| self.is_menu_target(label))
            .cloned()
            .or_else(|| {
                self.windows
                    .keys()
                    .find(|label| self.is_menu_target(label))
                    .cloned()
            })
    }

    pub fn is_ready(&self, label: &str) -> bool {
        self.windows
            .get(label)
            .is_some_and(|entry| entry.renderer_ready && !entry.closing)
    }

    pub fn on_close_requested(&mut self, label: &str) -> CloseRequestOutcome {
        // A window that is already standing down (closing) is visually gone;
        // the remaining one must not be prompted to keep it alive.
        let others_alive = self
            .windows
            .iter()
            .any(|(other, entry)| other != label && !entry.closing);
        let Some(entry) = self.windows.get_mut(label) else {
            return CloseRequestOutcome::Allow;
        };
        if entry.close_pending || entry.closing {
            entry.closing = true;
            return CloseRequestOutcome::Allow;
        }
        if others_alive && entry.renderer_ready {
            entry.close_pending = true;
            return CloseRequestOutcome::PreventAndAsk;
        }
        entry.closing = true;
        CloseRequestOutcome::Allow
    }

    pub fn mark_closing(&mut self, label: &str) {
        if let Some(entry) = self.windows.get_mut(label) {
            entry.closing = true;
            entry.close_pending = false;
        }
    }

    pub fn clear_close_pending(&mut self, label: &str) {
        if let Some(entry) = self.windows.get_mut(label) {
            if !entry.closing {
                entry.close_pending = false;
            }
        }
    }

    pub fn mark_renderer_ready(&mut self, label: &str) -> ReadyFlush {
        let Some(entry) = self.windows.get(label) else {
            return ReadyFlush {
                pending: Vec::new(),
                tabs: Vec::new(),
                reset_session: false,
            };
        };
        let reset_session = entry.renderer_ready;
        if reset_session {
            if let Some(entry) = self.windows.get_mut(label) {
                entry.pending_opens.clear();
                entry.pending_tabs.clear();
            }
            self.owners.retain(|_, owner| owner != label);
        }
        let Some(entry) = self.windows.get_mut(label) else {
            return ReadyFlush {
                pending: Vec::new(),
                tabs: Vec::new(),
                reset_session: false,
            };
        };
        entry.renderer_ready = true;
        entry.close_pending = false;
        ReadyFlush {
            pending: std::mem::take(&mut entry.pending_opens),
            tabs: std::mem::take(&mut entry.pending_tabs),
            reset_session,
        }
    }

    /// Queue a scratch tab for delivery once `label`'s renderer is ready.
    /// Returns false when the window is unknown or already gone.
    pub fn queue_tab(&mut self, label: &str, tab: PendingTab) -> bool {
        match self.windows.get_mut(label) {
            Some(entry) if !entry.closing => {
                entry.pending_tabs.push(tab);
                true
            }
            _ => false,
        }
    }

    /// Record the tab `label` is dragging, so a window that later receives the
    /// native drop knows what was dragged.
    pub fn begin_tab_drag(&mut self, label: &str, tab: TabDrag) -> bool {
        if !self.windows.contains_key(label) {
            return false;
        }
        self.drag = Some(tab);
        true
    }

    /// True while `label` owns the drag slot, i.e. the payload a native drag
    /// position stream should be routed back to.
    pub fn owns_tab_drag(&self, label: &str) -> bool {
        self.drag.as_ref().is_some_and(|drag| drag.source == label)
    }

    /// Drop any registration made by `label`. Called on `dragend` so a drag
    /// that ended inside its own window does not leave a stale payload behind.
    pub fn clear_tab_drag(&mut self, label: &str) {
        if self.drag.as_ref().is_some_and(|drag| drag.source == label) {
            self.drag = None;
        }
    }

    /// Remember that `source`'s tab was merged into another window, so a
    /// detach fallback from the same source cannot spawn a duplicate window.
    pub fn record_merge(&mut self, source: &str, tab_id: i64, now: Instant) {
        self.recent_merge = Some((source.to_string(), tab_id, now));
    }

    pub fn was_recently_merged(
        &self,
        source: &str,
        tab_id: i64,
        within: Duration,
        now: Instant,
    ) -> bool {
        self.recent_merge.as_ref().is_some_and(|(label, id, at)| {
            label == source && *id == tab_id && now.saturating_duration_since(*at) <= within
        })
    }

    /// Take the pending drag when `target` is the window that received the drop.
    /// Always clears the slot, so a payload can never be claimed twice. The
    /// caller compares `drag.source` with `target` to tell a self-drop from a
    /// merge into another window.
    pub fn take_tab_drag(&mut self, target: &str) -> Option<TabDrag> {
        let drag = self.drag.take()?;
        self.windows.contains_key(target).then_some(drag)
    }

    pub fn route_open(&mut self, path: PathBuf, requested: &str, grant_write: bool) -> RoutedOpen {
        let owner = self
            .owners
            .get(&path)
            .cloned()
            .filter(|owner| self.windows.get(owner).is_some_and(|entry| !entry.closing));
        let transferred = owner.as_deref().is_some_and(|owner| owner != requested);
        // A closing `requested` window can no longer receive anything; fall
        // back to a living window instead of queueing into a dying one.
        let requested_alive = self
            .windows
            .get(requested)
            .is_some_and(|entry| !entry.closing);
        let target = owner.unwrap_or_else(|| {
            if requested_alive {
                requested.to_string()
            } else {
                self.menu_target().unwrap_or_else(|| MAIN_LABEL.to_string())
            }
        });
        let ready = self.is_ready(&target);
        if !ready {
            if let Some(entry) = self.windows.get_mut(&target) {
                if let Some(existing) = entry
                    .pending_opens
                    .iter_mut()
                    .find(|open| open.path == path)
                {
                    existing.grant_write |= grant_write;
                } else {
                    entry.pending_opens.push(PendingOpen { path, grant_write });
                }
            }
        }
        RoutedOpen {
            target,
            grant_write,
            queued: !ready,
            transferred,
        }
    }

    pub fn set_owner(&mut self, path: PathBuf, label: impl Into<WindowLabel>) {
        self.owners.insert(path, label.into());
    }

    pub fn owner(&self, path: &Path) -> Option<&WindowLabel> {
        self.owners.get(path)
    }

    pub fn conflicts_with_other_owner(&self, path: &Path, label: &str) -> bool {
        self.owners.get(path).is_some_and(|owner| owner != label)
    }

    pub fn clear_owner_if(&mut self, path: &Path, label: &str) {
        if self.owners.get(path).is_some_and(|owner| owner == label) {
            self.owners.remove(path);
        }
    }

    pub fn context(&self, label: &str) -> Option<WindowContext> {
        self.windows.get(label).map(|entry| WindowContext {
            label: label.to_string(),
            role: entry.role.as_str().to_string(),
            workspace_id: entry.workspace_id.clone(),
        })
    }

    pub fn claim(&mut self, label: &str, ids: &[String]) -> Result<Vec<String>, &'static str> {
        if !self.windows.contains_key(label) {
            return Err("unknown window");
        }
        if ids.len() > MAX_CLAIM_IDS {
            return Err("too many workspace ids");
        }
        if ids.iter().any(|id| !is_workspace_id(id)) {
            return Err("invalid workspace id");
        }
        let mut set_workspace = self
            .windows
            .get(label)
            .is_some_and(|entry| entry.workspace_id.is_none());
        let mut granted = Vec::new();
        for id in ids {
            match self.claims.get(id).map(String::as_str) {
                Some(owner) if owner == label => granted.push(id.clone()),
                Some(_) => {}
                None => {
                    self.claims.insert(id.clone(), label.to_string());
                    granted.push(id.clone());
                    if set_workspace {
                        if let Some(entry) = self.windows.get_mut(label) {
                            entry.workspace_id = Some(id.clone());
                        }
                        set_workspace = false;
                    }
                }
            }
        }
        Ok(granted)
    }

    fn is_menu_target(&self, label: &str) -> bool {
        self.windows
            .get(label)
            .is_some_and(|entry| !entry.closing && !entry.close_pending)
    }
}

impl Default for WindowRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowContext {
    pub label: String,
    pub role: String,
    pub workspace_id: Option<String>,
}

pub struct WindowRegistryState(Mutex<WindowRegistry>);

impl WindowRegistryState {
    pub fn new() -> Self {
        Self(Mutex::new(WindowRegistry::new()))
    }

    pub fn lock(&self) -> std::sync::MutexGuard<'_, WindowRegistry> {
        self.0.lock().unwrap_or_else(|poison| poison.into_inner())
    }
}

impl Default for WindowRegistryState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn is_workspace_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// Absolute path plus lexical `.` / `..` cleanup. Does not touch the filesystem,
/// so symlinks stay as path text and the existing lstat checks still see them.
pub fn normalize_owned_path(path: &Path, cwd: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex_id(seed: u8) -> String {
        format!("{seed:02x}{}", "ab".repeat(15))
    }

    #[test]
    fn editor_labels_are_unique_and_never_reused() {
        let mut registry = WindowRegistry::new();
        let first = registry.allocate_editor().unwrap();
        let second = registry.allocate_editor().unwrap();
        assert_eq!(first, "editor-1");
        assert_eq!(second, "editor-2");
        registry.destroy_window(&first);
        let third = registry.allocate_editor().unwrap();
        assert_eq!(third, "editor-3");
        assert!(!registry.windows.contains_key(&first));
    }

    #[test]
    fn window_limit_counts_main() {
        let mut registry = WindowRegistry::new();
        for _ in 1..MAX_WINDOWS {
            registry.allocate_editor().unwrap();
        }
        assert_eq!(registry.allocate_editor(), Err("window limit reached"));
    }

    #[test]
    fn focus_order_skips_destroyed_and_closing_windows() {
        let mut registry = WindowRegistry::new();
        let editor = registry.allocate_editor().unwrap();
        registry.note_focus(MAIN_LABEL);
        registry.note_focus(&editor);
        assert_eq!(registry.menu_target().as_deref(), Some(editor.as_str()));

        registry.on_close_requested(&editor);
        assert_eq!(registry.menu_target().as_deref(), Some(MAIN_LABEL));

        registry.destroy_window(&editor);
        registry.note_focus(MAIN_LABEL);
        assert_eq!(registry.menu_target().as_deref(), Some(MAIN_LABEL));
    }

    #[test]
    fn open_queues_until_ready_then_flushes_and_reload_resets() {
        let mut registry = WindowRegistry::new();
        let path = PathBuf::from("/notes/a.md");
        let queued = registry.route_open(path.clone(), MAIN_LABEL, true);
        assert!(queued.queued);
        assert_eq!(queued.target, MAIN_LABEL);

        let flush = registry.mark_renderer_ready(MAIN_LABEL);
        assert!(!flush.reset_session);
        assert_eq!(flush.pending.len(), 1);
        assert_eq!(flush.pending[0].path, path);

        let live = registry.route_open(path.clone(), MAIN_LABEL, true);
        assert!(!live.queued);

        let reload = registry.mark_renderer_ready(MAIN_LABEL);
        assert!(reload.reset_session);
        assert!(reload.pending.is_empty());
    }

    #[test]
    fn owned_path_routes_back_to_the_owning_window() {
        let mut registry = WindowRegistry::new();
        let other = registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(MAIN_LABEL);
        registry.mark_renderer_ready(&other);
        let path = PathBuf::from("/notes/a.md");
        registry.set_owner(path.clone(), MAIN_LABEL);

        let routed = registry.route_open(path.clone(), &other, true);
        assert_eq!(routed.target, MAIN_LABEL);
        assert!(routed.transferred);
        assert!(!routed.queued);
        assert!(registry.conflicts_with_other_owner(&path, &other));
        assert!(!registry.conflicts_with_other_owner(&path, MAIN_LABEL));
    }

    #[test]
    fn claim_rejects_duplicates_bad_ids_and_releases_on_destroy() {
        let mut registry = WindowRegistry::new();
        let other = registry.allocate_editor().unwrap();
        let id = hex_id(1);
        let second = hex_id(2);
        assert_eq!(
            registry
                .claim(MAIN_LABEL, std::slice::from_ref(&id))
                .unwrap(),
            vec![id.clone()]
        );
        assert_eq!(
            registry.claim(&other, std::slice::from_ref(&id)).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            registry
                .claim(MAIN_LABEL, std::slice::from_ref(&id))
                .unwrap(),
            vec![id.clone()]
        );
        assert_eq!(
            registry.claim(MAIN_LABEL, &["ABC".to_string()]),
            Err("invalid workspace id")
        );
        assert_eq!(
            registry.claim(MAIN_LABEL, &["zz".to_string()]),
            Err("invalid workspace id")
        );
        let too_many = (0..MAX_CLAIM_IDS + 1)
            .map(|n| hex_id((n % 255) as u8))
            .collect::<Vec<_>>();
        assert_eq!(
            registry.claim(MAIN_LABEL, &too_many),
            Err("too many workspace ids")
        );
        assert_eq!(
            registry
                .context(MAIN_LABEL)
                .unwrap()
                .workspace_id
                .as_deref(),
            Some(id.as_str())
        );

        registry
            .claim(MAIN_LABEL, std::slice::from_ref(&second))
            .unwrap();
        assert_eq!(
            registry
                .context(MAIN_LABEL)
                .unwrap()
                .workspace_id
                .as_deref(),
            Some(id.as_str())
        );
        registry.destroy_window(MAIN_LABEL);
        assert_eq!(registry.claim(&other, &[id, second]).unwrap().len(), 2);
    }

    #[test]
    fn queued_tabs_wait_for_renderer_ready_then_flush_once() {
        let mut registry = WindowRegistry::new();
        let editor = registry.allocate_editor().unwrap();
        let tab = PendingTab {
            tab_id: 3,
            origin_workspace_id: Some(hex_id(7)),
            title: "Untitled 7".to_string(),
            content: "# hello".to_string(),
        };
        let second = PendingTab {
            tab_id: 8,
            origin_workspace_id: None,
            title: "Untitled 8".to_string(),
            content: String::new(),
        };

        // Queued tabs are held until the renderer signals readiness.
        assert!(registry.queue_tab(&editor, tab.clone()));
        assert!(registry.queue_tab(&editor, second.clone()));
        assert!(!registry.is_ready(&editor));

        let flush = registry.mark_renderer_ready(&editor);
        assert_eq!(flush.tabs, vec![tab, second]);
        assert!(!flush.reset_session);

        // The flush is one-shot; a later reload reports a reset and carries
        // nothing over.
        let reload = registry.mark_renderer_ready(&editor);
        assert!(reload.reset_session);
        assert!(reload.tabs.is_empty());
    }

    #[test]
    fn tab_drag_merges_into_the_dropping_window_only_once() {
        let mut registry = WindowRegistry::new();
        let source = registry.allocate_editor().unwrap();
        let target = registry.allocate_editor().unwrap();
        let drag = TabDrag {
            source: source.clone(),
            tab_id: 3,
            origin_workspace_id: Some(hex_id(9)),
            title: "Untitled 3".to_string(),
            content: "body".to_string(),
            file_path: None,
        };

        assert!(registry.begin_tab_drag(&source, drag.clone()));
        // Unknown windows cannot register a drag.
        assert!(!registry.begin_tab_drag(
            "nope",
            TabDrag {
                source: "nope".to_string(),
                tab_id: 4,
                origin_workspace_id: None,
                title: String::new(),
                content: String::new(),
                file_path: None,
            }
        ));

        let taken = registry.take_tab_drag(&target).unwrap();
        assert_eq!(taken, drag);
        // The slot is consumed, so a second drop finds nothing.
        assert!(registry.take_tab_drag(&target).is_none());
    }

    #[test]
    fn clear_tab_drag_only_drops_the_owning_window_drag() {
        let mut registry = WindowRegistry::new();
        let source = registry.allocate_editor().unwrap();
        let other = registry.allocate_editor().unwrap();
        registry.begin_tab_drag(
            &source,
            TabDrag {
                source: source.clone(),
                tab_id: 1,
                origin_workspace_id: None,
                title: "Untitled 1".to_string(),
                content: String::new(),
                file_path: None,
            },
        );

        // A different window must not cancel the drag.
        registry.clear_tab_drag(&other);
        assert!(registry.take_tab_drag(&other).is_some());

        registry.begin_tab_drag(
            &source,
            TabDrag {
                source: source.clone(),
                tab_id: 2,
                origin_workspace_id: None,
                title: "Untitled 2".to_string(),
                content: String::new(),
                file_path: None,
            },
        );
        registry.clear_tab_drag(&source);
        assert!(registry.take_tab_drag(&source).is_none());
    }

    #[test]
    fn a_self_drop_is_reported_so_the_source_can_detach() {
        let mut registry = WindowRegistry::new();
        let source = registry.allocate_editor().unwrap();
        registry.begin_tab_drag(
            &source,
            TabDrag {
                source: source.clone(),
                tab_id: 5,
                origin_workspace_id: Some(hex_id(2)),
                title: "Untitled 1".to_string(),
                content: String::new(),
                file_path: None,
            },
        );
        // Dropping on its own window still yields the payload (with source ==
        // target) so the caller can treat it as a detach.
        let taken = registry.take_tab_drag(&source).unwrap();
        assert_eq!(taken.source, source);
        assert_eq!(taken.tab_id, 5);
    }

    #[test]
    fn destroying_the_source_window_clears_its_drag() {
        let mut registry = WindowRegistry::new();
        let source = registry.allocate_editor().unwrap();
        let target = registry.allocate_editor().unwrap();
        registry.begin_tab_drag(
            &source,
            TabDrag {
                source: source.clone(),
                tab_id: 1,
                origin_workspace_id: None,
                title: "Untitled 1".to_string(),
                content: String::new(),
                file_path: None,
            },
        );
        registry.destroy_window(&source);
        assert!(registry.take_tab_drag(&target).is_none());
    }

    #[test]
    fn a_recent_merge_blocks_a_racing_detached_duplicate() {
        let mut registry = WindowRegistry::new();
        let source = registry.allocate_editor().unwrap();
        let now = Instant::now();

        assert!(!registry.was_recently_merged(&source, 7, TAB_DRAG_MERGE_GRACE, now));
        registry.record_merge(&source, 7, now);
        assert!(registry.was_recently_merged(&source, 7, TAB_DRAG_MERGE_GRACE, now));
        // A different tab (or a different source window) is not covered.
        assert!(!registry.was_recently_merged(&source, 8, TAB_DRAG_MERGE_GRACE, now));
        // And the record expires.
        assert!(!registry.was_recently_merged(
            &source,
            7,
            TAB_DRAG_MERGE_GRACE,
            now + TAB_DRAG_MERGE_GRACE + Duration::from_millis(1)
        ));
    }

    #[test]
    fn queue_tab_rejects_unknown_or_closing_windows() {
        let mut registry = WindowRegistry::new();
        let tab = PendingTab {
            tab_id: 1,
            origin_workspace_id: None,
            title: "Untitled 1".to_string(),
            content: String::new(),
        };
        assert!(!registry.queue_tab("nope", tab.clone()));

        let editor = registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(&editor);
        registry.mark_closing(&editor);
        assert!(!registry.queue_tab(&editor, tab));
    }

    #[test]
    fn second_close_while_pending_is_allowed() {
        let mut registry = WindowRegistry::new();
        registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(MAIN_LABEL);
        assert_eq!(
            registry.on_close_requested(MAIN_LABEL),
            CloseRequestOutcome::PreventAndAsk
        );
        assert_eq!(
            registry.on_close_requested(MAIN_LABEL),
            CloseRequestOutcome::Allow
        );
    }

    #[test]
    fn missing_requested_window_uses_a_living_window() {
        let mut registry = WindowRegistry::new();
        let editor = registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(&editor);
        registry.destroy_window(MAIN_LABEL);
        let routed = registry.route_open(PathBuf::from("/notes/a.md"), "gone", true);
        assert_eq!(routed.target, editor);
        assert!(!routed.queued);
    }

    #[test]
    fn last_window_closes_without_asking() {
        let mut registry = WindowRegistry::new();
        registry.mark_renderer_ready(MAIN_LABEL);
        assert_eq!(
            registry.on_close_requested(MAIN_LABEL),
            CloseRequestOutcome::Allow
        );
    }

    #[test]
    fn a_closing_window_does_not_count_as_another_alive_window() {
        let mut registry = WindowRegistry::new();
        let editor = registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(MAIN_LABEL);
        registry.mark_renderer_ready(&editor);

        // While both are alive, closing main asks first.
        assert_eq!(
            registry.on_close_requested(MAIN_LABEL),
            CloseRequestOutcome::PreventAndAsk
        );
        // The editor stands down; main must then close without a prompt, even
        // though its close happens while the editor is still being destroyed.
        registry.mark_closing(&editor);
        registry.clear_close_pending(MAIN_LABEL);
        assert_eq!(
            registry.on_close_requested(MAIN_LABEL),
            CloseRequestOutcome::Allow
        );
    }

    #[test]
    fn an_open_for_a_closing_window_moves_to_a_living_one() {
        let mut registry = WindowRegistry::new();
        let dying = registry.allocate_editor().unwrap();
        let living = registry.allocate_editor().unwrap();
        registry.mark_renderer_ready(&dying);
        registry.mark_renderer_ready(&living);
        registry.note_focus(&living);
        registry.mark_closing(&dying);

        let routed = registry.route_open(PathBuf::from("/notes/a.md"), &dying, true);
        assert_eq!(routed.target, living);
        assert!(!routed.queued);
    }

    #[test]
    fn normalize_drops_dot_segments_without_reading_the_disk() {
        let cwd = std::env::current_dir().unwrap();
        let relative = normalize_owned_path(Path::new("subdir/../note.md"), &cwd);
        assert_eq!(relative, cwd.join("note.md"));
        let dotted = cwd.join("foo").join("..").join("bar.md");
        assert_eq!(normalize_owned_path(&dotted, &cwd), cwd.join("bar.md"));
    }
}
