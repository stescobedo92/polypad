//! Start-up of the scripts workspace: preferences, scripts folder, recovery journal and the
//! watcher that reports external changes.
//!
//! Nothing here may stop PolyPad from starting: every failure falls back to a degraded mode (no
//! scripts folder, no crash recovery) that the UI explains.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock},
    thread,
    time::Duration,
};

use polypad_core::{
    preferences::{Preferences, PreferencesError, PreferencesFile, UiPreferences},
    recovery::RecoveryJournal,
    scripts::{
        store::{ScriptStore, SystemTrash, Trash},
        watcher::{ScriptChanges, ScriptWatcher, WatchEvent},
    },
};
use tauri::{AppHandle, Manager};

use crate::{
    error::DisplayChain,
    events::{ScriptsChanged, emit},
};

/// Pause before replacing a watcher that failed.
const WATCHER_RESTART_DELAY: Duration = Duration::from_secs(2);

/// Name of the scripts folder created in the user's documents.
pub const DEFAULT_FOLDER_NAME: &str = "PolyPad";

/// Default scripts folder: `Documents/PolyPad`, or `~/PolyPad` when the platform has no
/// documents folder (for example Linux without XDG user directories).
#[must_use]
pub fn default_scripts_root(documents: Option<PathBuf>, home: Option<PathBuf>) -> Option<PathBuf> {
    documents
        .or(home)
        .map(|folder| folder.join(DEFAULT_FOLDER_NAME))
}

/// Opens the first candidate folder that works, logging the ones that do not.
#[must_use]
pub fn open_first_store(
    candidates: impl IntoIterator<Item = PathBuf>,
    trash: impl Fn() -> Box<dyn Trash>,
) -> Option<ScriptStore> {
    candidates
        .into_iter()
        .find_map(|root| match ScriptStore::open(&root, trash()) {
            Ok(store) => Some(store),
            Err(error) => {
                tracing::warn!(error = %DisplayChain(&error), "cannot open a scripts folder");
                None
            }
        })
}

/// Folders the workspace lives in, resolved by the Tauri path resolver.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceDirs {
    /// Holds `preferences.json` (roams with the user profile on Windows).
    pub config: Option<PathBuf>,
    /// Holds the recovery journal (machine-local).
    pub local_data: Option<PathBuf>,
    /// The user's documents folder.
    pub documents: Option<PathBuf>,
    /// The user's home folder.
    pub home: Option<PathBuf>,
}

/// Shared state behind the workspace commands.
///
/// Locks are held for quick reads and swaps, never across an `.await`. The only I/O under a lock
/// is the preferences file, written while its lock is held so saves land in order.
#[derive(Debug)]
pub struct Workspace {
    store: RwLock<Option<Arc<ScriptStore>>>,
    watcher: Mutex<Option<ScriptWatcher>>,
    journal: Option<RecoveryJournal>,
    preferences_file: Option<PreferencesFile>,
    preferences: Mutex<Preferences>,
}

impl Workspace {
    /// Loads the preferences, opens the scripts folder and the recovery journal.
    #[must_use]
    pub fn load(dirs: &WorkspaceDirs) -> Self {
        let preferences_file = dirs
            .config
            .as_ref()
            .map(|config| PreferencesFile::new(config.join("preferences.json")));
        let preferences = preferences_file
            .as_ref()
            .map_or_else(Preferences::default, PreferencesFile::load);

        let default_root = default_scripts_root(dirs.documents.clone(), dirs.home.clone());
        let candidates = preferences
            .scripts_root
            .iter()
            .chain(default_root.iter())
            .cloned();
        let store = open_first_store(candidates, || Box::new(SystemTrash)).map(Arc::new);

        let journal = dirs.local_data.as_ref().and_then(|local| {
            RecoveryJournal::open(&local.join("recovery"))
                .inspect_err(|error| {
                    tracing::warn!(error = %DisplayChain(error), "crash recovery is not available");
                })
                .ok()
        });

        Self {
            store: RwLock::new(store),
            watcher: Mutex::new(None),
            journal,
            preferences_file,
            preferences: Mutex::new(preferences),
        }
    }

    /// The open scripts folder, if any.
    #[must_use]
    pub fn store(&self) -> Option<Arc<ScriptStore>> {
        self.store
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Switches to another scripts folder and remembers it.
    ///
    /// # Errors
    ///
    /// Fails when the choice cannot be saved; the switch still happens for this session.
    pub fn replace_store(&self, store: ScriptStore) -> Result<(), PreferencesError> {
        let root = store.root().to_owned();
        *self.store.write().unwrap_or_else(PoisonError::into_inner) = Some(Arc::new(store));
        self.update_preferences(|preferences| preferences.scripts_root = Some(root))
    }

    /// The recovery journal, when it could be opened.
    #[must_use]
    pub fn journal(&self) -> Option<&RecoveryJournal> {
        self.journal.as_ref()
    }

    /// The preferences the UI sees.
    #[must_use]
    pub fn ui_preferences(&self) -> UiPreferences {
        self.preferences().ui.clone()
    }

    /// Replaces the UI preferences and saves them.
    ///
    /// # Errors
    ///
    /// Fails when the preferences file cannot be written; the change still applies.
    pub fn set_ui_preferences(&self, ui: UiPreferences) -> Result<(), PreferencesError> {
        self.update_preferences(|preferences| preferences.ui = ui)
    }

    /// The watcher slot; replacing its content stops the previous watcher.
    pub fn watcher(&self) -> MutexGuard<'_, Option<ScriptWatcher>> {
        self.watcher.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn preferences(&self) -> MutexGuard<'_, Preferences> {
        self.preferences
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn update_preferences(
        &self,
        change: impl FnOnce(&mut Preferences),
    ) -> Result<(), PreferencesError> {
        let mut preferences = self.preferences();
        change(&mut preferences);
        match &self.preferences_file {
            Some(file) => file.save(&preferences),
            None => Ok(()),
        }
    }
}

/// Starts watching the current scripts folder, replacing any previous watcher.
///
/// A watcher that reports errors may have stopped (notify unwatches on some Windows errors), so
/// the UI is told to re-read everything and a new watcher replaces it after a short pause.
pub fn watch_scripts(app: &AppHandle) {
    let Some(workspace) = app.try_state::<Workspace>() else {
        return;
    };
    let Some(store) = workspace.store() else {
        *workspace.watcher() = None;
        return;
    };
    let handle = app.clone();
    let started = ScriptWatcher::start(store.root(), move |event| match event {
        WatchEvent::Changes(changes) => emit(&handle, &ScriptsChanged(changes)),
        WatchEvent::Failed => {
            let rescan = ScriptChanges {
                rescan: true,
                ..ScriptChanges::default()
            };
            emit(&handle, &ScriptsChanged(rescan));
            // Not from this thread: it belongs to the watcher being replaced.
            let handle = handle.clone();
            thread::spawn(move || {
                thread::sleep(WATCHER_RESTART_DELAY);
                watch_scripts(&handle);
            });
        }
    });
    *workspace.watcher() = started
        .inspect_err(|error| {
            tracing::warn!(error = %DisplayChain(error), "external changes will not be noticed");
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use polypad_core::scripts::store::SystemTrash;

    use super::{default_scripts_root, open_first_store};

    #[test]
    fn scripts_live_in_documents_or_else_in_home() {
        let documents = PathBuf::from("docs");
        let home = PathBuf::from("home");

        assert_eq!(
            default_scripts_root(Some(documents.clone()), Some(home.clone())),
            Some(documents.join("PolyPad"))
        );
        assert_eq!(
            default_scripts_root(None, Some(home.clone())),
            Some(home.join("PolyPad"))
        );
        assert_eq!(default_scripts_root(None, None), None);
    }

    #[test]
    fn falls_back_to_the_next_folder_that_can_be_opened() {
        let temp = tempfile::tempdir().unwrap();
        // A file where a folder is expected cannot become the scripts folder.
        let blocked = temp.path().join("blocked");
        fs::write(&blocked, "not a folder").unwrap();
        let usable = temp.path().join("usable");

        let store = open_first_store([blocked.join("scripts"), usable.clone()], || {
            Box::new(SystemTrash)
        })
        .unwrap();

        assert_eq!(store.root(), dunce::canonicalize(&usable).unwrap());
    }

    #[test]
    fn no_usable_folder_means_no_store() {
        let temp = tempfile::tempdir().unwrap();
        let blocked = temp.path().join("blocked");
        fs::write(&blocked, "not a folder").unwrap();

        assert!(open_first_store([blocked.join("a")], || Box::new(SystemTrash)).is_none());
    }
}
