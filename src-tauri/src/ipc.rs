//! Typed IPC surface shared with the WebView.
//!
//! tauri-specta generates `ui/src/shared/ipc/bindings.ts` from the commands and types
//! registered here, so the frontend only ever calls typed wrappers (docs/adr/0002).
//! Regenerate with `pnpm bindings`; CI fails when the committed file is stale.

use std::path::{Path, PathBuf};

use specta_typescript::Typescript;
use tauri::Wry;
use tauri_specta::{Builder, collect_commands};

use crate::{commands, error::CommandError};

/// Location of the generated bindings, relative to this crate's manifest directory.
const BINDINGS_RELATIVE_PATH: &str = "../ui/src/shared/ipc/bindings.ts";

/// Builds the registry of commands and types exposed to the WebView.
#[must_use]
pub fn builder() -> Builder<Wry> {
    Builder::<Wry>::new()
        .commands(collect_commands![commands::app_info])
        .typ::<CommandError>()
}

/// Absolute path of the committed bindings file.
#[must_use]
pub fn bindings_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(BINDINGS_RELATIVE_PATH)
}

/// Writes the TypeScript bindings to `path`.
///
/// # Errors
///
/// Fails when the bindings cannot be generated or the file cannot be written.
pub fn export_bindings(path: &Path) -> Result<(), specta_typescript::Error> {
    builder().export(Typescript::default(), path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::{bindings_path, export_bindings};

    /// Regenerates the committed bindings. Run through `pnpm bindings`.
    #[test]
    #[ignore = "writes into the source tree; run explicitly via `pnpm bindings`"]
    fn export() {
        export_bindings(&bindings_path()).unwrap();
    }

    #[test]
    fn committed_bindings_are_up_to_date() {
        let temp = tempfile::tempdir().unwrap();
        let fresh_path = temp.path().join("bindings.ts");
        export_bindings(&fresh_path).unwrap();

        let fresh = fs::read_to_string(&fresh_path).unwrap();
        let committed = fs::read_to_string(bindings_path()).unwrap_or_default();
        assert!(
            committed == fresh,
            "ui/src/shared/ipc/bindings.ts is stale; regenerate it with `pnpm bindings`"
        );
    }
}
