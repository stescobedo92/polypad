//! Secret handling for PolyPad.
//!
//! Phase 0 provides [`Redacted`], a wrapper that keeps sensitive values out of logs and error
//! messages. Storage in the OS keychain (via `keyring`) arrives with database connections in
//! Phase 4.

use std::fmt;

/// Placeholder rendered instead of a secret value.
pub const REDACTED: &str = "[REDACTED]";

/// Wraps a sensitive value (password, token, connection string) so it cannot leak by accident.
///
/// `Debug` and `Display` always render [`REDACTED`], which makes the wrapper safe to place in
/// `tracing` fields, error values or any struct that derives `Debug`. The type deliberately
/// does not implement `serde::Serialize`, so a secret cannot end up in IPC payloads, `.ppad`
/// files or logs without an explicit [`Redacted::expose`] call that shows up in review.
#[derive(Clone, Default)]
pub struct Redacted<T>(T);

impl<T> Redacted<T> {
    /// Wraps `value`.
    pub const fn new(value: T) -> Self {
        Self(value)
    }

    /// Borrows the secret. Every call site is a place where the secret leaves the wrapper.
    pub const fn expose(&self) -> &T {
        &self.0
    }

    /// Unwraps the secret, consuming the wrapper.
    pub fn into_inner(self) -> T {
        self.0
    }
}

impl<T> From<T> for Redacted<T> {
    fn from(value: T) -> Self {
        Self::new(value)
    }
}

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

impl<T> fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(REDACTED)
    }
}

#[cfg(test)]
mod tests {
    use super::{REDACTED, Redacted};

    const SECRET: &str = "hunter2";

    #[test]
    fn debug_and_display_never_show_the_value() {
        let secret = Redacted::new(SECRET.to_owned());

        assert_eq!(format!("{secret:?}"), REDACTED);
        assert_eq!(format!("{secret:#?}"), REDACTED);
        assert_eq!(secret.to_string(), REDACTED);
    }

    #[test]
    fn redaction_survives_derived_debug_of_containing_types() {
        #[derive(Debug)]
        #[allow(dead_code)] // fields are only read through the derived Debug impl
        struct Connection {
            host: &'static str,
            password: Redacted<&'static str>,
        }

        let rendered = format!(
            "{:?}",
            Connection {
                host: "db.internal",
                password: SECRET.into(),
            }
        );

        assert!(rendered.contains("db.internal"));
        assert!(rendered.contains(REDACTED));
        assert!(!rendered.contains(SECRET));
    }

    #[test]
    fn value_is_reachable_only_through_explicit_accessors() {
        let secret = Redacted::from(SECRET.to_owned());

        assert_eq!(secret.expose(), SECRET);
        assert_eq!(secret.into_inner(), SECRET);
    }
}
