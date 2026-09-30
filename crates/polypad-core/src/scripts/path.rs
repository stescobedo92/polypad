//! Paths of scripts and folders, relative to the scripts root.
//!
//! The rules are the strictest of the supported platforms, so a folder created on one OS opens
//! on the others: no characters Windows forbids, no reserved device names, no trailing dot or
//! space, no hidden entries, at most 255 bytes per component. Paths use `/` and never contain
//! `.` or `..`, so joining one to the root cannot leave it lexically.

use std::fmt;

use serde::{Deserialize, Serialize};

/// File extension of scripts, without the dot.
pub const SCRIPT_EXTENSION: &str = "ppad";

/// Longest component, in bytes: file systems allow 255, and atomic writes put the name between
/// a `.` and a `.XXXXXX` suffix in their temporary file.
pub const MAX_NAME_BYTES: usize = 247;

/// One validated path component: the name of a script or folder.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct EntryName(String);

/// A validated path of a script or folder inside the scripts root, such as
/// `reports/orders.ppad`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type), specta(transparent))]
#[serde(try_from = "String", into = "String")]
pub struct ScriptPath(String);

/// Why a name or path is not acceptable.
///
/// Serialized as `{ "kind": "invalidCharacter", "character": ":" }` so the UI can explain it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[cfg_attr(feature = "specta", derive(specta::Type))]
#[serde(tag = "kind", content = "character", rename_all = "camelCase")]
#[non_exhaustive]
pub enum NameError {
    /// The name, or a path component, is empty.
    #[error("the name is empty")]
    Empty,
    /// The name exceeds [`MAX_NAME_BYTES`].
    #[error("the name is longer than {MAX_NAME_BYTES} bytes")]
    TooLong,
    /// The name starts with a dot (hidden entries, `.` and `..`).
    #[error("names cannot start with a dot")]
    LeadingDot,
    /// The name contains a character some platform forbids.
    #[error("names cannot contain {0:?}")]
    InvalidCharacter(char),
    /// The name is a Windows device name such as `CON` or `LPT1`.
    #[error("the name is reserved by Windows")]
    ReservedName,
    /// The name ends with a dot or a space, which Windows strips.
    #[error("names cannot end with a dot or a space")]
    TrailingDotOrSpace,
}

impl EntryName {
    /// Validates a single name.
    ///
    /// # Errors
    ///
    /// Returns the first rule the name breaks.
    pub fn new(name: &str) -> Result<Self, NameError> {
        validate_name(name)?;
        Ok(Self(name.to_owned()))
    }

    /// The name as written.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl ScriptPath {
    /// Validates a `/`-separated path.
    ///
    /// # Errors
    ///
    /// Returns the first rule a component breaks; an empty path or component is
    /// [`NameError::Empty`].
    pub fn new(path: &str) -> Result<Self, NameError> {
        path.split('/').try_for_each(validate_name)?;
        Ok(Self(path.to_owned()))
    }

    /// The path of `name` inside `parent`, or at the root when `parent` is `None`.
    #[must_use]
    pub fn child(parent: Option<&Self>, name: &EntryName) -> Self {
        match parent {
            Some(parent) => Self(format!("{}/{}", parent.0, name.0)),
            None => Self(name.0.clone()),
        }
    }

    /// The path as a `/`-separated string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Last component.
    #[must_use]
    pub fn name(&self) -> &str {
        self.0
            .rsplit_once('/')
            .map_or(self.0.as_str(), |(_, name)| name)
    }

    /// The containing folder, or `None` for entries at the root.
    #[must_use]
    pub fn parent(&self) -> Option<Self> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| Self(parent.to_owned()))
    }

    /// Components from the root down.
    pub fn components(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// Whether this path is `ancestor` or lies inside it (compared by component).
    #[must_use]
    pub fn is_within(&self, ancestor: &Self) -> bool {
        self.0
            .strip_prefix(ancestor.0.as_str())
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    }

    /// The path this entry gets when moved into `folder` (the root when `None`).
    #[must_use]
    pub fn moved_to(&self, folder: Option<&Self>) -> Self {
        match folder {
            Some(folder) => Self(format!("{}/{}", folder.0, self.name())),
            None => Self(self.name().to_owned()),
        }
    }

    /// Whether this names a script (a `.ppad` file, compared case-insensitively).
    #[must_use]
    pub fn is_script(&self) -> bool {
        self.name()
            .rsplit_once('.')
            .is_some_and(|(_, extension)| extension.eq_ignore_ascii_case(SCRIPT_EXTENSION))
    }
}

/// Characters Windows forbids in names; `/` is also the path separator everywhere.
const FORBIDDEN_CHARACTERS: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

/// Windows device names, reserved with any extension (`nul.ppad` names the device).
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

fn validate_name(name: &str) -> Result<(), NameError> {
    if name.is_empty() {
        return Err(NameError::Empty);
    }
    if name.len() > MAX_NAME_BYTES {
        return Err(NameError::TooLong);
    }
    if name.starts_with('.') {
        return Err(NameError::LeadingDot);
    }
    if let Some(invalid) = name
        .chars()
        .find(|c| c.is_ascii_control() || FORBIDDEN_CHARACTERS.contains(c))
    {
        return Err(NameError::InvalidCharacter(invalid));
    }
    // Windows ignores trailing spaces here too: `CON .txt` is the console device.
    let stem = name
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .trim_end_matches(' ');
    if RESERVED_NAMES
        .iter()
        .any(|reserved| stem.eq_ignore_ascii_case(reserved))
    {
        return Err(NameError::ReservedName);
    }
    if name.ends_with(['.', ' ']) {
        return Err(NameError::TrailingDotOrSpace);
    }
    Ok(())
}

impl TryFrom<String> for ScriptPath {
    type Error = NameError;

    fn try_from(path: String) -> Result<Self, Self::Error> {
        Self::new(&path)
    }
}

impl From<ScriptPath> for String {
    fn from(path: ScriptPath) -> Self {
        path.0
    }
}

impl fmt::Display for ScriptPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::{EntryName, NameError, ScriptPath};

    fn path(raw: &str) -> ScriptPath {
        ScriptPath::new(raw).unwrap()
    }

    #[test]
    fn accepts_ordinary_names() {
        for name in [
            "orders.ppad",
            "reports",
            "My Script (2).ppad",
            "données.ppad",
            "a.b.c",
            " leading space is legal",
            "CONSOLE.ppad",
            "com10",
            &"x".repeat(247),
        ] {
            assert_eq!(EntryName::new(name).unwrap().as_str(), name);
        }
    }

    #[test]
    fn rejects_names_that_break_a_platform_rule() {
        let cases = [
            ("", NameError::Empty),
            (".", NameError::LeadingDot),
            ("..", NameError::LeadingDot),
            (".git", NameError::LeadingDot),
            ("a/b", NameError::InvalidCharacter('/')),
            ("a\\b", NameError::InvalidCharacter('\\')),
            ("a:b", NameError::InvalidCharacter(':')),
            ("what?", NameError::InvalidCharacter('?')),
            ("a*b", NameError::InvalidCharacter('*')),
            ("<a>", NameError::InvalidCharacter('<')),
            ("a|b", NameError::InvalidCharacter('|')),
            ("say \"hi\"", NameError::InvalidCharacter('"')),
            ("tab\there", NameError::InvalidCharacter('\t')),
            ("nul\0byte", NameError::InvalidCharacter('\0')),
            ("CON", NameError::ReservedName),
            ("nul.ppad", NameError::ReservedName),
            ("Com1.txt", NameError::ReservedName),
            ("lpt9", NameError::ReservedName),
            ("aux.tar.gz", NameError::ReservedName),
            ("CON .ppad", NameError::ReservedName),
            ("nul  ", NameError::ReservedName),
            ("name.", NameError::TrailingDotOrSpace),
            ("name ", NameError::TrailingDotOrSpace),
        ];
        for (name, expected) in cases {
            assert_eq!(EntryName::new(name), Err(expected), "{name:?}");
        }
        // Atomic writes add `.` + `.XXXXXX` around the name, and 255 bytes is the file system limit.
        assert_eq!(EntryName::new(&"x".repeat(248)), Err(NameError::TooLong));
        // 124 two-byte characters: 248 bytes although only 124 characters.
        assert_eq!(EntryName::new(&"é".repeat(124)), Err(NameError::TooLong));
    }

    #[test]
    fn paths_are_validated_component_by_component() {
        let cases = [
            ("", NameError::Empty),
            ("/reports", NameError::Empty),
            ("reports/", NameError::Empty),
            ("a//b", NameError::Empty),
            ("a/../b", NameError::LeadingDot),
            ("./a", NameError::LeadingDot),
            ("a\\..\\b", NameError::InvalidCharacter('\\')),
            ("C:/a", NameError::InvalidCharacter(':')),
            ("reports/CON", NameError::ReservedName),
        ];
        for (raw, expected) in cases {
            assert_eq!(ScriptPath::new(raw), Err(expected), "{raw:?}");
        }
    }

    #[test]
    fn exposes_name_parent_and_components() {
        let script = path("reports/2026/orders.ppad");

        assert_eq!(script.name(), "orders.ppad");
        assert_eq!(script.parent(), Some(path("reports/2026")));
        assert_eq!(
            script.components().collect::<Vec<_>>(),
            ["reports", "2026", "orders.ppad"]
        );
        assert_eq!(path("orders.ppad").parent(), None);
    }

    #[test]
    fn builds_children_of_the_root_and_of_folders() {
        let name = EntryName::new("orders.ppad").unwrap();

        assert_eq!(ScriptPath::child(None, &name), path("orders.ppad"));
        assert_eq!(
            ScriptPath::child(Some(&path("reports")), &name),
            path("reports/orders.ppad")
        );
    }

    #[test]
    fn moving_keeps_the_name_under_the_new_folder() {
        let script = path("reports/2026/orders.ppad");

        assert_eq!(script.moved_to(None), path("orders.ppad"));
        assert_eq!(
            script.moved_to(Some(&path("archive"))),
            path("archive/orders.ppad")
        );
    }

    #[test]
    fn containment_compares_whole_components() {
        let folder = path("reports");

        assert!(path("reports").is_within(&folder));
        assert!(path("reports/orders.ppad").is_within(&folder));
        assert!(path("reports/2026/q1.ppad").is_within(&folder));
        assert!(!path("reports-old/orders.ppad").is_within(&folder));
        assert!(!path("rep").is_within(&folder));
    }

    #[test]
    fn recognizes_scripts_by_extension() {
        assert!(path("orders.ppad").is_script());
        assert!(path("reports/ORDERS.PPAD").is_script());
        assert!(!path("reports").is_script());
        assert!(!path("orders.ppad.bak").is_script());
    }

    #[test]
    fn crosses_the_ipc_boundary_as_a_validated_string() {
        assert_eq!(
            serde_json::to_value(path("reports/orders.ppad")).unwrap(),
            serde_json::json!("reports/orders.ppad")
        );
        assert_eq!(
            serde_json::from_value::<ScriptPath>(serde_json::json!("reports/orders.ppad")).unwrap(),
            path("reports/orders.ppad")
        );
        assert!(serde_json::from_value::<ScriptPath>(serde_json::json!("../secrets")).is_err());
    }
}
