//! Typed events the backend emits to the WebView (registered in `ipc.rs`).

use polypad_core::scripts::watcher::ScriptChanges;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::AppHandle;
use tauri_specta::Event;

/// Other programs changed the scripts folder; re-read what the batch mentions.
#[derive(Debug, Clone, Serialize, Deserialize, Type, Event)]
pub struct ScriptsChanged(pub ScriptChanges);

/// The window is closing: flush pending journal writes, then call `ready_to_close`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, Event)]
pub struct FlushRequested;

/// Emits `event`, logging instead of failing: a lost notification is recovered by the UI's
/// periodic reconciliation.
pub fn emit<E: Event + Serialize + Clone>(app: &AppHandle, event: &E) {
    if let Err(error) = event.emit(app) {
        tracing::warn!(%error, event = E::NAME, "cannot emit an event");
    }
}
