use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget, Runtime};

pub fn emit_to_window<R, S>(app: &AppHandle<R>, label: &str, event: &str, payload: S)
where
    R: Runtime,
    S: Serialize + Clone,
{
    if let Err(error) = app.emit_to(EventTarget::webview_window(label), event, payload) {
        eprintln!("failed to emit {event} to {label}: {error}");
    }
}

pub fn emit_except_window<R, S>(app: &AppHandle<R>, sender: &str, event: &str, payload: S)
where
    R: Runtime,
    S: Serialize + Clone,
{
    let sender = sender.to_string();
    if let Err(error) = app.emit_filter(event, payload, move |target| match target {
        EventTarget::WebviewWindow { label } | EventTarget::Webview { label } => label != &sender,
        _ => false,
    }) {
        eprintln!("failed to emit {event}: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::webview::WebviewWindowBuilder;
    use tauri::{Listener, WebviewUrl};

    #[test]
    fn emit_to_window_reaches_only_the_destination_but_listen_any_sees_it() {
        let app = tauri::test::mock_app();
        let handle = app.handle().clone();
        let main = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::default())
            .build()
            .expect("main window");
        let other = WebviewWindowBuilder::new(&handle, "editor-1", WebviewUrl::default())
            .build()
            .expect("editor window");

        let main_hits = Arc::new(AtomicUsize::new(0));
        let other_hits = Arc::new(AtomicUsize::new(0));
        let any_hits = Arc::new(AtomicUsize::new(0));
        let main_counter = main_hits.clone();
        let other_counter = other_hits.clone();
        let any_counter = any_hits.clone();
        main.listen("ping", move |_| {
            main_counter.fetch_add(1, Ordering::SeqCst);
        });
        other.listen("ping", move |_| {
            other_counter.fetch_add(1, Ordering::SeqCst);
        });
        handle.listen_any("ping", move |_| {
            any_counter.fetch_add(1, Ordering::SeqCst);
        });

        emit_to_window(&handle, "main", "ping", ());

        assert_eq!(main_hits.load(Ordering::SeqCst), 1);
        assert_eq!(other_hits.load(Ordering::SeqCst), 0);
        assert_eq!(
            any_hits.load(Ordering::SeqCst),
            1,
            "a target-Any listener also receives emit_to, which is why the bridge must not use the global listen"
        );
    }
}
