//! The error type every fallible command returns to the WebView.

use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use specta::Type;

/// Error returned by fallible commands.
///
/// Serialized as `{ "code": "internal", "reference": "…" }`. It never carries internal paths,
/// secrets or user code: the full cause is written to the log under the same `reference`, so
/// what the user sees can be matched to a log entry without leaking details over IPC.
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

    use super::CommandError;

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
