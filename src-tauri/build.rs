//! Tauri build script.
//!
//! Listing the app's commands in `AppManifest::commands` turns each one into an ACL permission
//! (`allow-<command>`), so a window can only invoke the commands its capability file grants.
//! Without this list, every registered command would be callable from every window.

use std::path::PathBuf;

/// Commands registered in `src/ipc.rs`; keep both lists in sync.
const APP_COMMANDS: &[&str] = &[
    "app_info",
    "workspace_snapshot",
    "journal_buffer",
    "discard_buffer",
    "set_session",
    "ready_to_close",
    "list_scripts",
    "open_script",
    "script_status",
    "save_script",
    "create_script",
    "create_folder",
    "rename_entry",
    "move_entry",
    "delete_entry",
    "choose_scripts_folder",
    "update_preferences",
];

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS));
    let attributes = if is_windows_msvc() {
        embed_windows_manifest()?;
        // The manifest is embedded by the linker instead (see below), so it must not be
        // compiled into the resource file a second time.
        attributes.windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest())
    } else {
        attributes
    };

    tauri_build::try_build(attributes)?;
    Ok(())
}

fn is_windows_msvc() -> bool {
    std::env::var("CARGO_CFG_TARGET_OS").is_ok_and(|os| os == "windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|env| env == "msvc")
}

/// Embeds the Windows application manifest through the linker for every final artifact.
///
/// tauri-build puts the manifest in a resource that only binaries link, so unit-test
/// executables lack the Common Controls v6 dependency and die at start-up with
/// `STATUS_ENTRYPOINT_NOT_FOUND`. Linker arguments apply to tests and binaries alike, which
/// keeps both identical. This mirrors what the `tauri` crate does for its own tests.
#[allow(clippy::print_stdout)] // build scripts talk to Cargo through stdout
fn embed_windows_manifest() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR")?)
        .join("windows")
        .join("app.manifest");
    let manifest = manifest
        .to_str()
        .ok_or("the manifest path is not valid UTF-8")?;

    println!("cargo:rerun-if-changed={manifest}");
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{manifest}");
    Ok(())
}
