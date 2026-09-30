//! Tauri commands exposed to the WebView.
//!
//! Every command must also be listed in `build.rs` (`AppManifest::commands`), registered in
//! `ipc.rs` and granted in a capability file, otherwise the WebView cannot call it. Commands are
//! thin: they move work onto a blocking thread and translate errors; the logic lives in
//! `polypad-core`.

pub mod app;
pub mod preferences;
pub mod scripts;
pub mod session;

use std::{io, sync::Arc};

use polypad_core::scripts::store::ScriptStore;
use tauri::{AppHandle, Manager, State};

use crate::{error::CommandError, workspace::Workspace};

/// Runs file work on a blocking thread so the async runtime never stalls.
async fn blocking<T, F>(work: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| CommandError::internal(&error))?
}

fn workspace(app: &AppHandle) -> Result<State<'_, Workspace>, CommandError> {
    app.try_state::<Workspace>().ok_or_else(|| {
        CommandError::internal(&io::Error::other("the workspace is not initialized yet"))
    })
}

fn store(app: &AppHandle) -> Result<Arc<ScriptStore>, CommandError> {
    workspace(app)?
        .store()
        .ok_or(CommandError::ScriptsFolderUnavailable)
}
