//! Start-up snapshot, recovery journal and the close handshake.

use polypad_core::{
    preferences::UiPreferences,
    recovery::{BufferId, BufferSnapshot, RecoveredSession, RecoveryError, Session},
};
use serde::Serialize;
use specta::Type;
use tauri::AppHandle;

use super::{blocking, scripts::ScriptsFolder, workspace};
use crate::{closing, error::CommandError, error::DisplayChain};

/// Everything the UI needs to draw its first frame.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSnapshot {
    /// UI preferences (layout, key bindings, last language).
    pub preferences: UiPreferences,
    /// The scripts folder; `null` when none could be opened and the user must choose one.
    pub scripts_folder: Option<ScriptsFolder>,
    /// Tabs to reopen, with their unsaved changes.
    pub session: RecoveredSession,
    /// Whether unsaved changes are journaled; `false` means a crash would lose them.
    pub recovery_available: bool,
    /// Name of the chosen scripts folder when it could not be opened at start-up (an unplugged
    /// drive, a moved folder); `scriptsFolder` is then the default folder, or `null`.
    pub unavailable_folder: Option<String>,
}

impl From<RecoveryError> for CommandError {
    fn from(error: RecoveryError) -> Self {
        tracing::warn!(error = %DisplayChain(&error), "the recovery journal failed");
        Self::RecoveryUnavailable
    }
}

/// Preferences, scripts tree and recovered tabs in one call at start-up.
///
/// # Errors
///
/// Only `internal`: a missing folder or journal is reported inside the snapshot.
#[tauri::command]
#[specta::specta]
pub async fn workspace_snapshot(app: AppHandle) -> Result<WorkspaceSnapshot, CommandError> {
    blocking(move || {
        let workspace = workspace(&app)?;
        let scripts_folder = match workspace.store() {
            Some(store) => match ScriptsFolder::of(&store) {
                Ok(folder) => Some(folder),
                Err(CommandError::ScriptsFolderUnavailable) => None,
                Err(error) => return Err(error),
            },
            None => None,
        };
        let session = match workspace.journal() {
            Some(journal) => journal.load(workspace.folder_id().as_ref()).unwrap_or_else(|error| {
                tracing::warn!(error = %DisplayChain(&error), "cannot read the recovery journal");
                RecoveredSession::default()
            }),
            None => RecoveredSession::default(),
        };
        Ok(WorkspaceSnapshot {
            preferences: workspace.ui_preferences(),
            scripts_folder,
            session,
            recovery_available: workspace.journal().is_some(),
            unavailable_folder: workspace.unavailable_folder().map(str::to_owned),
        })
    })
    .await
}

/// Records the unsaved state of a buffer.
///
/// # Errors
///
/// `recoveryUnavailable` when the journal cannot be written.
#[tauri::command]
#[specta::specta]
pub async fn journal_buffer(
    app: AppHandle,
    buffer_id: BufferId,
    snapshot: BufferSnapshot,
) -> Result<(), CommandError> {
    blocking(move || {
        let workspace = workspace(&app)?;
        let journal = workspace
            .journal()
            .ok_or(CommandError::RecoveryUnavailable)?;
        Ok(journal.put_buffer(&buffer_id, &snapshot, workspace.folder_id().as_ref())?)
    })
    .await
}

/// Forgets a buffer's unsaved state (saved, reverted or closed).
///
/// # Errors
///
/// `recoveryUnavailable` when the journal cannot be written.
#[tauri::command]
#[specta::specta]
pub async fn discard_buffer(app: AppHandle, buffer_id: BufferId) -> Result<(), CommandError> {
    blocking(move || {
        let workspace = workspace(&app)?;
        let journal = workspace
            .journal()
            .ok_or(CommandError::RecoveryUnavailable)?;
        Ok(journal.discard_buffer(&buffer_id)?)
    })
    .await
}

/// Records the open tabs.
///
/// # Errors
///
/// `recoveryUnavailable` when the journal cannot be written.
#[tauri::command]
#[specta::specta]
pub async fn set_session(app: AppHandle, session: Session) -> Result<(), CommandError> {
    blocking(move || {
        let workspace = workspace(&app)?;
        let journal = workspace
            .journal()
            .ok_or(CommandError::RecoveryUnavailable)?;
        Ok(journal.set_session(&session, workspace.folder_id().as_ref())?)
    })
    .await
}

/// The UI has flushed its pending journal writes after `FlushRequested`; close the window.
#[tauri::command]
#[specta::specta]
#[allow(clippy::needless_pass_by_value)] // Tauri injects command arguments by value
pub fn ready_to_close(app: AppHandle) {
    closing::close_now(&app);
}
