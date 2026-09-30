//! Preferences the UI owns (layout, key bindings, last language).

use polypad_core::preferences::UiPreferences;
use tauri::AppHandle;

use super::{blocking, workspace};
use crate::error::CommandError;

/// Replaces the UI preferences and saves them.
///
/// # Errors
///
/// `internal` when the preferences file cannot be written; the change still applies for this
/// session.
#[tauri::command]
#[specta::specta]
pub async fn update_preferences(
    app: AppHandle,
    preferences: UiPreferences,
) -> Result<(), CommandError> {
    blocking(move || {
        workspace(&app)?
            .set_ui_preferences(preferences)
            .map_err(|error| CommandError::internal(&error))
    })
    .await
}
