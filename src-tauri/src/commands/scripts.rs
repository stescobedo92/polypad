//! Scripts and folders under the scripts root.

use std::path::Path;

use polypad_core::{
    ppad::Document,
    scripts::{
        path::{EntryName, ScriptPath},
        store::{ContentStamp, LoadedScript, ScriptStore, SystemTrash},
        tree::ScriptTree,
    },
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{blocking, store, workspace};
use crate::{error::CommandError, workspace::watch_scripts};

/// The scripts folder as the explorer shows it.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ScriptsFolder {
    /// Folder name (never the full path, which stays in Rust).
    pub name: String,
    /// Its contents.
    pub tree: ScriptTree,
}

/// A script that was just created.
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CreatedScript {
    /// Where it was created.
    pub path: ScriptPath,
    /// Stamp of the written file.
    pub stamp: ContentStamp,
}

impl ScriptsFolder {
    /// Lists `store` for the explorer.
    ///
    /// # Errors
    ///
    /// Fails when the folder cannot be read.
    pub fn of(store: &ScriptStore) -> Result<Self, CommandError> {
        Ok(Self {
            name: folder_name(store.root()),
            tree: store.list()?,
        })
    }
}

fn folder_name(root: &Path) -> String {
    root.file_name().map_or_else(
        || root.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn entry_name(name: &str) -> Result<EntryName, CommandError> {
    EntryName::new(name).map_err(|problem| CommandError::InvalidName { problem })
}

/// Lists the scripts folder.
///
/// # Errors
///
/// `scriptsFolderUnavailable` when the folder is gone or unreadable.
#[tauri::command]
#[specta::specta]
pub async fn list_scripts(app: AppHandle) -> Result<ScriptTree, CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.list()?)).await
}

/// Reads a script.
///
/// # Errors
///
/// `notFound`, `notAScript`, `unsupportedDocument` or `outsideScriptsFolder`.
#[tauri::command]
#[specta::specta]
pub async fn open_script(app: AppHandle, path: ScriptPath) -> Result<LoadedScript, CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.read(&path)?)).await
}

/// Stamp of a script on disk, or `null` when it does not exist.
///
/// # Errors
///
/// `notAScript` or `outsideScriptsFolder`.
#[tauri::command]
#[specta::specta]
pub async fn script_status(
    app: AppHandle,
    path: ScriptPath,
) -> Result<Option<ContentStamp>, CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.stamp(&path)?)).await
}

/// Saves a script if the disk still holds `expected` (`null`: no file).
///
/// # Errors
///
/// `conflict` when the disk changed (the file is left untouched), `notFound` when its folder
/// is gone, `notAScript` or `outsideScriptsFolder`.
#[tauri::command]
#[specta::specta]
pub async fn save_script(
    app: AppHandle,
    path: ScriptPath,
    document: Document,
    expected: Option<ContentStamp>,
) -> Result<ContentStamp, CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.save(&path, &document, expected.as_ref())?)).await
}

/// Creates a script in `parent` (the root when `null`).
///
/// # Errors
///
/// `invalidName`, `alreadyExists`, `notAScript` (the name lacks `.ppad`), `notFound` or
/// `notAFolder` for `parent`.
#[tauri::command]
#[specta::specta]
pub async fn create_script(
    app: AppHandle,
    parent: Option<ScriptPath>,
    name: String,
    document: Document,
) -> Result<CreatedScript, CommandError> {
    let store = store(&app)?;
    let name = entry_name(&name)?;
    blocking(move || {
        let (path, stamp) = store.create_script(parent.as_ref(), &name, &document)?;
        Ok(CreatedScript { path, stamp })
    })
    .await
}

/// Creates a folder in `parent` (the root when `null`).
///
/// # Errors
///
/// `invalidName`, `alreadyExists`, `notFound` or `notAFolder` for `parent`.
#[tauri::command]
#[specta::specta]
pub async fn create_folder(
    app: AppHandle,
    parent: Option<ScriptPath>,
    name: String,
) -> Result<ScriptPath, CommandError> {
    let store = store(&app)?;
    let name = entry_name(&name)?;
    blocking(move || Ok(store.create_folder(parent.as_ref(), &name)?)).await
}

/// Renames a script or folder in place.
///
/// # Errors
///
/// `invalidName`, `alreadyExists`, `notFound` or `notAScript` (a script would lose `.ppad`).
#[tauri::command]
#[specta::specta]
pub async fn rename_entry(
    app: AppHandle,
    path: ScriptPath,
    name: String,
) -> Result<ScriptPath, CommandError> {
    let store = store(&app)?;
    let name = entry_name(&name)?;
    blocking(move || Ok(store.rename(&path, &name)?)).await
}

/// Moves a script or folder into `folder` (the root when `null`).
///
/// # Errors
///
/// `moveIntoItself`, `alreadyExists`, `notFound` or `notAFolder`.
#[tauri::command]
#[specta::specta]
pub async fn move_entry(
    app: AppHandle,
    path: ScriptPath,
    folder: Option<ScriptPath>,
) -> Result<ScriptPath, CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.move_to(&path, folder.as_ref())?)).await
}

/// Moves a script or folder to the operating system's trash.
///
/// # Errors
///
/// `notFound`, `outsideScriptsFolder`, or `internal` when the trash refuses it.
#[tauri::command]
#[specta::specta]
pub async fn delete_entry(app: AppHandle, path: ScriptPath) -> Result<(), CommandError> {
    let store = store(&app)?;
    blocking(move || Ok(store.delete(&path)?)).await
}

/// Lets the user pick another scripts folder; `null` when the dialog was cancelled.
///
/// The UI must not call this while scripts of the current folder have unsaved changes.
///
/// # Errors
///
/// `scriptsFolderUnavailable` when the chosen folder cannot be used.
#[tauri::command]
#[specta::specta]
pub async fn choose_scripts_folder(
    app: AppHandle,
    window: WebviewWindow,
    title: String,
) -> Result<Option<ScriptsFolder>, CommandError> {
    workspace(&app)?;
    let picker = app.dialog().file().set_parent(&window).set_title(title);
    blocking(move || {
        // The blocking variant is safe here: this is a worker thread, not the main thread.
        let Some(chosen) = picker.blocking_pick_folder() else {
            return Ok(None);
        };
        let root = chosen
            .into_path()
            .map_err(|error| CommandError::internal(&error))?;
        let store = ScriptStore::open(&root, Box::new(SystemTrash))?;
        let folder = ScriptsFolder::of(&store)?;
        let workspace = workspace(&app)?;
        if let Err(error) = workspace.replace_store(store) {
            tracing::warn!(%error, "cannot remember the scripts folder");
        }
        watch_scripts(&app);
        Ok(Some(folder))
    })
    .await
}
