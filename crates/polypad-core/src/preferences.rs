//! User preferences, stored as JSON in the app's configuration folder.
//!
//! Preferences never stop PolyPad from starting: a missing file means defaults, and a file that
//! cannot be read is moved aside (`preferences.invalid-<millis>.json`) before defaults are used.
//! Fields this build does not know are kept, so older and newer versions can share the file.

use std::{
    collections::BTreeMap,
    fs, io,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use serde_json::{Map, Value};

use crate::{atomic_fs, language::Language};

/// Version this build writes.
pub const PREFERENCES_VERSION: u64 = 1;

/// Sizes of the panels of each resizable group, in percent, keyed by group id then panel id.
pub type Layout = BTreeMap<String, BTreeMap<String, f64>>;

/// Everything stored in the preferences file.
#[derive(Debug, Clone, PartialEq)]
pub struct Preferences {
    /// Folder holding the user's scripts; `None` uses the default location.
    pub scripts_root: Option<PathBuf>,
    /// Preferences the UI reads and writes.
    pub ui: UiPreferences,
    /// Format version of the file this came from (never lowered when saving).
    version: u64,
    /// Fields this build does not know.
    extra: Map<String, Value>,
}

/// The part of the preferences the UI sees; it never includes file system paths.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UiPreferences {
    /// Panel sizes (see [`Layout`]).
    pub layout: Layout,
    /// Key binding overrides by command id; `None` unbinds the command.
    pub keybindings: BTreeMap<String, Option<String>>,
    /// Language of the last script created, used for the next new script.
    pub last_language: Option<Language>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            scripts_root: None,
            ui: UiPreferences::default(),
            version: PREFERENCES_VERSION,
            extra: Map::new(),
        }
    }
}

/// The file's layout.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesRepr {
    #[serde(default = "current_version")]
    version: u64,
    #[serde(default)]
    scripts_root: Option<PathBuf>,
    #[serde(default)]
    layout: Layout,
    #[serde(default)]
    keybindings: BTreeMap<String, Option<String>>,
    #[serde(default, deserialize_with = "lenient")]
    last_language: Option<Language>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

const fn current_version() -> u64 {
    PREFERENCES_VERSION
}

/// Treats a value this build cannot decode (such as a language added later) as absent.
fn lenient<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let value = Option::<Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}

/// The preferences file.
#[derive(Debug, Clone)]
pub struct PreferencesFile {
    path: PathBuf,
}

/// Why the preferences could not be saved.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum PreferencesError {
    /// The file cannot be written.
    #[error("the preferences file cannot be written")]
    Io(#[from] io::Error),
    /// The preferences could not be encoded.
    #[error("the preferences could not be encoded")]
    Encode(#[from] serde_json::Error),
}

impl PreferencesFile {
    /// The preferences stored at `path` (which may not exist yet).
    #[must_use]
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Reads the preferences; see the module documentation for how failures are handled.
    #[must_use]
    pub fn load(&self) -> Preferences {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Preferences::default(),
            Err(error) => {
                tracing::warn!(%error, "cannot read the preferences; using defaults");
                return Preferences::default();
            }
        };
        match serde_json::from_str::<PreferencesRepr>(&text) {
            Ok(repr) => Preferences {
                scripts_root: repr.scripts_root,
                ui: UiPreferences {
                    layout: repr.layout,
                    keybindings: repr.keybindings,
                    last_language: repr.last_language,
                },
                version: repr.version,
                extra: repr.extra,
            },
            Err(error) => {
                tracing::warn!(%error, "the preferences are invalid; moving them aside and using defaults");
                self.move_aside();
                Preferences::default()
            }
        }
    }

    /// Writes the preferences atomically.
    ///
    /// # Errors
    ///
    /// Fails when the file cannot be written.
    pub fn save(&self, preferences: &Preferences) -> Result<(), PreferencesError> {
        let repr = PreferencesRepr {
            version: preferences.version.max(PREFERENCES_VERSION),
            scripts_root: preferences.scripts_root.clone(),
            layout: preferences.ui.layout.clone(),
            keybindings: preferences.ui.keybindings.clone(),
            last_language: preferences.ui.last_language,
            extra: preferences.extra.clone(),
        };
        let json = serde_json::to_vec_pretty(&repr)?;
        if let Some(folder) = self.path.parent() {
            fs::create_dir_all(folder)?;
        }
        atomic_fs::write(&self.path, &json)?;
        Ok(())
    }

    fn move_aside(&self) {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis());
        let aside = self
            .path
            .with_file_name(format!("preferences.invalid-{millis}.json"));
        if let Err(error) = fs::rename(&self.path, aside) {
            tracing::warn!(%error, "cannot move the invalid preferences aside");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, fs, path::PathBuf};

    use serde_json::{Value, json};

    use super::{Preferences, PreferencesFile, UiPreferences};
    use crate::language::Language;

    fn file() -> (tempfile::TempDir, PreferencesFile, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("preferences.json");
        (temp, PreferencesFile::new(&path), path)
    }

    fn on_disk(path: &std::path::Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_missing_file_means_defaults() {
        let (_temp, preferences, _) = file();

        assert_eq!(preferences.load(), Preferences::default());
    }

    #[test]
    fn saved_preferences_load_back_with_camel_case_keys_on_disk() {
        let (_temp, preferences, path) = file();
        let saved = Preferences {
            scripts_root: Some(PathBuf::from("/home/ada/PolyPad")),
            ui: UiPreferences {
                layout: BTreeMap::from([(
                    "workspace".to_owned(),
                    BTreeMap::from([("explorer".to_owned(), 18.5), ("main".to_owned(), 81.5)]),
                )]),
                keybindings: BTreeMap::from([
                    ("palette.open".to_owned(), Some("Ctrl+K".to_owned())),
                    ("results.toggle".to_owned(), None),
                ]),
                last_language: Some(Language::Go),
            },
            ..Preferences::default()
        };

        preferences.save(&saved).unwrap();

        assert_eq!(preferences.load(), saved);
        assert_eq!(
            on_disk(&path),
            json!({
                "version": 1,
                "scriptsRoot": "/home/ada/PolyPad",
                "layout": { "workspace": { "explorer": 18.5, "main": 81.5 } },
                "keybindings": { "palette.open": "Ctrl+K", "results.toggle": null },
                "lastLanguage": "go"
            })
        );
    }

    #[test]
    fn unknown_fields_survive_a_save() {
        let (_temp, preferences, path) = file();
        fs::write(
            &path,
            r#"{"version":1,"lastLanguage":"sql","theme":"sepia","editor":{"fontSize":15}}"#,
        )
        .unwrap();

        let mut loaded = preferences.load();
        loaded.ui.last_language = Some(Language::Rust);
        preferences.save(&loaded).unwrap();

        let written = on_disk(&path);
        assert_eq!(written["theme"], json!("sepia"));
        assert_eq!(written["editor"], json!({ "fontSize": 15 }));
        assert_eq!(written["lastLanguage"], json!("rust"));
    }

    #[test]
    fn an_unknown_language_is_forgotten_without_losing_the_rest() {
        let (_temp, preferences, path) = file();
        fs::write(
            &path,
            r#"{"version":1,"lastLanguage":"cobol","scriptsRoot":"/scripts"}"#,
        )
        .unwrap();

        let loaded = preferences.load();

        assert_eq!(loaded.ui.last_language, None);
        assert_eq!(loaded.scripts_root, Some(PathBuf::from("/scripts")));
    }

    #[test]
    fn an_unreadable_file_is_moved_aside_and_defaults_are_used() {
        let (temp, preferences, path) = file();
        fs::write(&path, "{ broken").unwrap();

        let loaded = preferences.load();

        assert_eq!(loaded, Preferences::default());
        assert!(!path.exists());
        let aside: Vec<_> = fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert!(
            aside[0].starts_with("preferences.invalid-")
                && std::path::Path::new(&aside[0])
                    .extension()
                    .is_some_and(|extension| extension == "json"),
            "{aside:?}"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join(&aside[0])).unwrap(),
            "{ broken"
        );
    }

    #[test]
    fn a_file_from_a_newer_version_keeps_its_version_when_saved() {
        let (_temp, preferences, path) = file();
        fs::write(&path, r#"{"version":3,"lastLanguage":"java"}"#).unwrap();

        let loaded = preferences.load();
        preferences.save(&loaded).unwrap();

        assert_eq!(loaded.ui.last_language, Some(Language::Java));
        assert_eq!(on_disk(&path)["version"], json!(3));
    }

    #[test]
    fn the_ui_part_never_carries_the_scripts_root() {
        let json = serde_json::to_value(UiPreferences::default()).unwrap();

        assert_eq!(
            json,
            json!({ "layout": {}, "keybindings": {}, "lastLanguage": null })
        );
    }
}
