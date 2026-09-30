//! Closing the main window without losing the last keystrokes.
//!
//! The first close request is held back while the UI flushes its pending journal writes
//! (`FlushRequested`, answered by `ready_to_close`); after [`FLUSH_TIMEOUT`] the window closes
//! anyway, so a stuck WebView cannot keep PolyPad open.

use std::{
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

use tauri::{AppHandle, CloseRequestApi, Manager, Window};

use crate::events::{FlushRequested, emit};

/// How long the UI gets to flush before the window closes regardless.
pub const FLUSH_TIMEOUT: Duration = Duration::from_secs(1);

/// Label of the main window in `tauri.conf.json`.
pub const MAIN_WINDOW: &str = "main";

/// Whether the close has been confirmed; managed as app state.
#[derive(Debug, Default)]
pub struct CloseGuard {
    closing: AtomicBool,
    confirmed: AtomicBool,
}

/// Handles `WindowEvent::CloseRequested` for the main window.
pub fn on_close_requested(window: &Window, api: &CloseRequestApi) {
    let app = window.app_handle();
    let Some(guard) = app.try_state::<CloseGuard>() else {
        return;
    };
    if window.label() != MAIN_WINDOW || guard.confirmed.load(Ordering::Acquire) {
        return;
    }
    api.prevent_close();
    // Repeated clicks on the close button while flushing must not restart the handshake.
    if guard.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    emit(app, &FlushRequested);
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FLUSH_TIMEOUT);
        close_now(&app);
    });
}

/// Closes the main window once, bypassing the close handshake.
pub fn close_now(app: &AppHandle) {
    let Some(guard) = app.try_state::<CloseGuard>() else {
        return;
    };
    if guard.confirmed.swap(true, Ordering::AcqRel) {
        return;
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW)
        && let Err(error) = window.destroy()
    {
        tracing::warn!(%error, "cannot close the main window");
    }
}
