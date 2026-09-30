//! The error type every fallible command returns to the WebView.

use std::sync::atomic::{AtomicU64, Ordering};

use polypad_core::{
    ppad::PpadError,
    scripts::{
        path::{NameError, ScriptPath},
        store::{ContentStamp, ScriptError},
    },
};
use serde::Serialize;
use specta::Type;

/// Error returned by fallible commands.
///
/// Serialized with a `code` tag, for example `{ "code": "conflict", "path": "a.ppad", … }`. It
/// never carries absolute paths, secrets or user code: expected failures carry only data the UI
/// sent (script paths relative to the scripts folder) or fixed reason codes, and anything
/// unexpected becomes `internal`, whose cause is logged under the same `reference`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Type)]
#[serde(tag = "code", rename_all = "camelCase")]
#[non_exhaustive]
pub enum CommandError {
    /// An unexpected failure. The cause is logged, never sent.
    #[error("internal error (reference {reference})")]
    Internal {
        /// Correlates this response with the log entry that holds the cause.
        reference: String,
    },
    /// The script or folder does not exist.
    #[error("{path} does not exist")]
    NotFound {
        /// The entry.
        path: ScriptPath,
    },
    /// An entry with that path already exists.
    #[error("{path} already exists")]
    AlreadyExists {
        /// The entry.
        path: ScriptPath,
    },
    /// The script changed on disk since the caller read it.
    #[error("{path} changed on disk")]
    Conflict {
        /// The script.
        path: ScriptPath,
        /// Stamp of what is on disk now; `null` when the file is gone.
        current: Option<ContentStamp>,
    },
    /// A name typed by the user breaks a naming rule.
    #[error("invalid name: {problem}")]
    InvalidName {
        /// The rule it breaks.
        problem: NameError,
    },
    /// The entry is not a script.
    #[error("{path} is not a script")]
    NotAScript {
        /// The entry.
        path: ScriptPath,
    },
    /// The entry is not a folder.
    #[error("{path} is not a folder")]
    NotAFolder {
        /// The entry.
        path: ScriptPath,
    },
    /// A folder cannot move into itself or one of its subfolders.
    #[error("{path} cannot be moved into itself")]
    MoveIntoItself {
        /// The folder.
        path: ScriptPath,
    },
    /// The entry resolves outside the scripts folder (a link pointing elsewhere).
    #[error("{path} is outside the scripts folder")]
    OutsideScriptsFolder {
        /// The entry.
        path: ScriptPath,
    },
    /// The file is not a script this build can open.
    #[error("{path} cannot be opened")]
    UnsupportedDocument {
        /// The file.
        path: ScriptPath,
        /// Why.
        problem: DocumentProblem,
    },
    /// The document is too large to be saved as a script (it could not be reopened).
    #[error("{path} is too large to be saved")]
    DocumentTooLarge {
        /// The script.
        path: ScriptPath,
    },
    /// The operating system trash refused the entry (network drives often have none).
    #[error("{path} could not be moved to the trash")]
    TrashUnavailable {
        /// The entry.
        path: ScriptPath,
    },
    /// No scripts folder could be opened; the user has to choose one.
    #[error("the scripts folder is not available")]
    ScriptsFolderUnavailable,
    /// The recovery journal cannot be written; editing works, crash recovery does not.
    #[error("crash recovery is not available")]
    RecoveryUnavailable,
}

/// Why a file cannot be opened as a script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[non_exhaustive]
pub enum DocumentProblem {
    /// The file does not start with a JSON header.
    MissingHeader,
    /// The header is not valid JSON.
    InvalidHeader {
        /// One-based line.
        line: u32,
        /// One-based column.
        column: u32,
    },
    /// No `---` line after the header.
    MissingSeparator {
        /// One-based line where it was expected.
        line: u32,
    },
    /// The format version is missing or malformed.
    InvalidVersion,
    /// Written by a newer PolyPad.
    NewerFormat,
    /// The header names an unknown language.
    UnknownLanguage,
    /// The header names an unknown mode.
    UnknownMode,
    /// A header field has the wrong type.
    InvalidField {
        /// The field.
        field: String,
    },
    /// Larger than scripts may be.
    TooLarge,
    /// Not UTF-8 text.
    InvalidEncoding,
    /// Another problem, described in the log.
    Other,
}

impl From<ScriptError> for CommandError {
    fn from(error: ScriptError) -> Self {
        match error {
            ScriptError::NotFound(path) => Self::NotFound { path },
            ScriptError::AlreadyExists(path) => Self::AlreadyExists { path },
            ScriptError::Conflict { path, current } => Self::Conflict { path, current },
            ScriptError::NotAScript(path) => Self::NotAScript { path },
            ScriptError::NotAFolder(path) => Self::NotAFolder { path },
            ScriptError::MoveIntoItself(path) => Self::MoveIntoItself { path },
            ScriptError::OutsideRoot(path) => Self::OutsideScriptsFolder { path },
            ScriptError::TooLarge(path) => Self::DocumentTooLarge { path },
            ScriptError::Trash { path, source } => {
                tracing::warn!(%path, error = %DisplayChain(&source), "the trash refused an entry");
                Self::TrashUnavailable { path }
            }
            ScriptError::InvalidEncoding(path) => Self::UnsupportedDocument {
                path,
                problem: DocumentProblem::InvalidEncoding,
            },
            ScriptError::Root(source) => {
                tracing::warn!(error = %DisplayChain(&source), "the scripts folder is not accessible");
                Self::ScriptsFolderUnavailable
            }
            ScriptError::Document { path, source } => {
                tracing::info!(%path, error = %source, "a script cannot be opened");
                Self::UnsupportedDocument {
                    path,
                    problem: DocumentProblem::from(&source),
                }
            }
            other => Self::internal(&other),
        }
    }
}

impl From<&PpadError> for DocumentProblem {
    fn from(error: &PpadError) -> Self {
        let position = |value: usize| u32::try_from(value).unwrap_or(u32::MAX);
        match error {
            PpadError::MissingHeader => Self::MissingHeader,
            PpadError::InvalidHeader { line, column, .. } => Self::InvalidHeader {
                line: position(*line),
                column: position(*column),
            },
            PpadError::MissingSeparator { line } => Self::MissingSeparator {
                line: position(*line),
            },
            PpadError::InvalidVersion => Self::InvalidVersion,
            PpadError::NewerFormat { .. } => Self::NewerFormat,
            PpadError::UnknownLanguage(_) => Self::UnknownLanguage,
            PpadError::UnknownMode(_) => Self::UnknownMode,
            PpadError::InvalidField { field, .. } => Self::InvalidField {
                field: (*field).to_owned(),
            },
            PpadError::TooLarge { .. } => Self::TooLarge,
            _ => Self::Other,
        }
    }
}

impl CommandError {
    /// Logs `cause` and returns the sanitized error that crosses the IPC boundary.
    pub fn internal(cause: &(dyn std::error::Error + 'static)) -> Self {
        let reference = next_reference();
        tracing::error!(%reference, error = %DisplayChain(cause), "command failed");
        Self::Internal { reference }
    }
}

/// Short, process-unique correlation id (for example `E-1a2b3c-7`).
fn next_reference() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("E-{:x}-{sequence}", std::process::id())
}

/// Formats an error followed by its chain of sources (`outer: cause: root cause`).
pub(crate) struct DisplayChain<'a>(pub(crate) &'a (dyn std::error::Error + 'static));

impl std::fmt::Display for DisplayChain<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)?;
        let mut source = self.0.source();
        while let Some(cause) = source {
            write!(f, ": {cause}")?;
            source = cause.source();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::io;

    use polypad_core::{
        ppad::PpadError,
        scripts::{
            path::{NameError, ScriptPath},
            store::{ContentStamp, ScriptError},
        },
    };
    use serde_json::json;

    use super::{CommandError, DocumentProblem};

    fn path(raw: &str) -> ScriptPath {
        ScriptPath::new(raw).unwrap()
    }

    #[test]
    fn expected_store_failures_keep_their_meaning() {
        let p = path("reports/a.ppad");
        let cases = [
            (
                ScriptError::NotFound(p.clone()),
                CommandError::NotFound { path: p.clone() },
            ),
            (
                ScriptError::AlreadyExists(p.clone()),
                CommandError::AlreadyExists { path: p.clone() },
            ),
            (
                ScriptError::NotAScript(p.clone()),
                CommandError::NotAScript { path: p.clone() },
            ),
            (
                ScriptError::NotAFolder(p.clone()),
                CommandError::NotAFolder { path: p.clone() },
            ),
            (
                ScriptError::MoveIntoItself(p.clone()),
                CommandError::MoveIntoItself { path: p.clone() },
            ),
            (
                ScriptError::OutsideRoot(p.clone()),
                CommandError::OutsideScriptsFolder { path: p.clone() },
            ),
            (
                ScriptError::Conflict {
                    path: p.clone(),
                    current: Some(ContentStamp::of(b"disk")),
                },
                CommandError::Conflict {
                    path: p.clone(),
                    current: Some(ContentStamp::of(b"disk")),
                },
            ),
            (
                ScriptError::TooLarge(p.clone()),
                CommandError::DocumentTooLarge { path: p.clone() },
            ),
            (
                ScriptError::Trash {
                    path: p.clone(),
                    source: io::Error::other("no recycle bin on this volume"),
                },
                CommandError::TrashUnavailable { path: p.clone() },
            ),
            (
                ScriptError::InvalidEncoding(p.clone()),
                CommandError::UnsupportedDocument {
                    path: p.clone(),
                    problem: DocumentProblem::InvalidEncoding,
                },
            ),
        ];
        for (error, expected) in cases {
            assert_eq!(CommandError::from(error), expected);
        }
    }

    #[test]
    fn document_problems_carry_positions_but_not_contents() {
        let p = path("a.ppad");
        let cases = [
            (
                PpadError::InvalidHeader {
                    line: 4,
                    column: 3,
                    message: "expected `,` near \"secret\"".to_owned(),
                },
                DocumentProblem::InvalidHeader { line: 4, column: 3 },
            ),
            (
                PpadError::MissingSeparator { line: 6 },
                DocumentProblem::MissingSeparator { line: 6 },
            ),
            (
                PpadError::NewerFormat {
                    found: 2,
                    supported: 1,
                },
                DocumentProblem::NewerFormat,
            ),
            (
                PpadError::UnknownLanguage("cobol".to_owned()),
                DocumentProblem::UnknownLanguage,
            ),
            (
                PpadError::InvalidField {
                    field: "imports",
                    message: "invalid type".to_owned(),
                },
                DocumentProblem::InvalidField {
                    field: "imports".to_owned(),
                },
            ),
            (PpadError::MissingHeader, DocumentProblem::MissingHeader),
        ];
        for (source, problem) in cases {
            let error = CommandError::from(ScriptError::Document {
                path: p.clone(),
                source,
            });
            assert_eq!(
                error,
                CommandError::UnsupportedDocument {
                    path: p.clone(),
                    problem
                }
            );
            assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
        }
    }

    #[test]
    fn a_vanished_scripts_folder_asks_the_user_for_another() {
        let error = CommandError::from(ScriptError::Root(io::Error::other("unplugged drive")));

        assert_eq!(error, CommandError::ScriptsFolderUnavailable);
    }

    #[test]
    fn unexpected_store_failures_become_internal_without_their_cause() {
        let error = CommandError::from(ScriptError::Io {
            path: path("a.ppad"),
            source: io::Error::other("C:\\Users\\someone\\secret.ppad is locked"),
        });

        assert!(matches!(error, CommandError::Internal { .. }));
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    }

    #[test]
    fn errors_are_tagged_by_code_for_the_ui() {
        let conflict = CommandError::Conflict {
            path: path("a.ppad"),
            current: None,
        };
        let invalid_name = CommandError::InvalidName {
            problem: NameError::InvalidCharacter(':'),
        };

        assert_eq!(
            serde_json::to_value(conflict).unwrap(),
            json!({ "code": "conflict", "path": "a.ppad", "current": null })
        );
        assert_eq!(
            serde_json::to_value(invalid_name).unwrap(),
            json!({ "code": "invalidName", "problem": { "kind": "invalidCharacter", "character": ":" } })
        );
        assert_eq!(
            serde_json::to_value(CommandError::ScriptsFolderUnavailable).unwrap(),
            json!({ "code": "scriptsFolderUnavailable" })
        );
    }

    #[test]
    fn internal_errors_serialize_without_the_cause() {
        let cause = io::Error::other("C:\\Users\\someone\\secret.txt is locked");
        let error = CommandError::internal(&cause);

        let json = serde_json::to_value(&error).unwrap();
        assert_eq!(json["code"], "internal");
        assert!(
            json["reference"]
                .as_str()
                .is_some_and(|r| r.starts_with("E-"))
        );

        let rendered = format!("{json} {error}");
        assert!(!rendered.contains("secret.txt"), "{rendered}");
    }

    #[test]
    fn references_are_unique_within_the_process() {
        let cause = io::Error::other("boom");
        let first = CommandError::internal(&cause);
        let second = CommandError::internal(&cause);

        assert_ne!(first, second);
    }
}
