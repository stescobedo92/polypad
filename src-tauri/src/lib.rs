//! PolyPad desktop application: wires the Tauri runtime to the `polypad-*` crates.
//!
//! Commands are thin adapters that translate between IPC types and domain services; business
//! logic lives in the library crates so it can be tested without a WebView.

pub mod closing;
pub mod commands;
pub mod error;
pub mod events;
pub mod ipc;
pub mod workspace;

use std::{path::PathBuf, process::ExitCode};

use polypad_core::telemetry::{self, TelemetryConfig, TelemetryGuard};
use tauri::{App, AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::{
    closing::{CloseGuard, MAIN_WINDOW},
    error::DisplayChain,
    workspace::{Workspace, WorkspaceDirs},
};

/// Starts PolyPad and blocks until the last window closes.
#[must_use]
pub fn run() -> ExitCode {
    match try_run() {
        Ok(code) => code,
        Err(error) => {
            report_startup_failure(&error);
            ExitCode::FAILURE
        }
    }
}

fn try_run() -> Result<ExitCode, tauri::Error> {
    let ipc = ipc::builder();
    let app = tauri::Builder::default()
        // Both plugins are used from Rust only; no capability grants them to the WebView.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // Not VISIBLE: the window starts hidden and is shown once restored (below).
                .with_state_flags(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(ipc.invoke_handler())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                closing::on_close_requested(window, api);
            }
        })
        .build(tauri::generate_context!())?;
    ipc.mount_events(&app);

    // Set up here rather than in `Builder::setup`, whose failures panic inside the event loop.
    let telemetry = start_telemetry(app.path().app_log_dir());
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "PolyPad started"
    );
    // The event loop has not started yet, so no command can run before the state exists.
    start_workspace(&app);

    // `run_return` (unlike `run`) hands control back instead of calling `process::exit`, so
    // dropping the telemetry guard below flushes the last buffered log records.
    let exit_code = app.run_return(|app, event| {
        // Config windows are only created once the event loop starts, so `Ready` is the first
        // moment the main window exists (already restored by window-state).
        if matches!(event, RunEvent::Ready) {
            show_main_window(app);
        }
    });
    tracing::info!(exit_code, "PolyPad exited");
    drop(telemetry);

    Ok(u8::try_from(exit_code).map_or(ExitCode::FAILURE, ExitCode::from))
}

/// Opens the workspace and starts watching the scripts folder.
fn start_workspace(app: &App) {
    let paths = app.path();
    let dirs = WorkspaceDirs {
        config: paths.app_config_dir().ok(),
        local_data: paths.app_local_data_dir().ok(),
        documents: paths.document_dir().ok(),
        home: paths.home_dir().ok(),
    };
    app.manage(CloseGuard::default());
    app.manage(Workspace::load(&dirs));
    workspace::watch_scripts(app.handle());
}

/// Shows the main window, which starts hidden so it never flashes at its default geometry.
fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        tracing::error!("the main window was not created");
        return;
    };
    if let Err(error) = window.show() {
        tracing::error!(%error, "cannot show the main window");
    }
}

/// Starts file logging and crash reports in `log_dir`, falling back to stderr: a logging
/// problem must never block start-up.
///
/// Without a log directory there is nowhere to write a crash report, so the panic hook is left
/// alone: the default one already reports panics on stderr, the channel logging falls back to.
fn start_telemetry(log_dir: tauri::Result<PathBuf>) -> Option<TelemetryGuard> {
    let log_dir = match log_dir {
        Ok(log_dir) => log_dir,
        Err(error) => {
            init_stderr_fallback();
            tracing::error!(
                error = %DisplayChain(&error),
                "the log directory cannot be resolved; logging to stderr only"
            );
            return None;
        }
    };

    let guard = match telemetry::init(&TelemetryConfig::new(&log_dir)) {
        Ok(guard) => Some(guard),
        Err(error) => {
            init_stderr_fallback();
            tracing::error!(
                error = %DisplayChain(&error),
                log_dir = %log_dir.display(),
                "file logging is unavailable; logging to stderr only"
            );
            None
        }
    };
    // Installed even when file logging failed: the crash report is a separate file that may
    // still be writable.
    telemetry::install_panic_hook(log_dir);
    guard
}

fn init_stderr_fallback() {
    // Can only fail if a subscriber is already installed, in which case that subscriber
    // receives the error record that follows.
    let _ = telemetry::init_stderr_only();
}

/// Reports a failure to create the Tauri runtime, which happens before logging exists.
///
/// Best effort: release builds on Windows have no console. Panics after this point are
/// recorded by the panic hook instead (see docs/adr/0004).
#[allow(clippy::print_stderr)] // no logger is available yet; stderr is the only channel left
fn report_startup_failure(error: &tauri::Error) {
    eprintln!("PolyPad failed to start: {}", DisplayChain(error));
}

#[cfg(test)]
mod tests {
    use super::start_telemetry;

    #[test]
    fn an_unresolvable_log_directory_does_not_stop_start_up() {
        // What `app_log_dir` returns when the platform has no home or data directory.
        assert!(start_telemetry(Err(tauri::Error::UnknownPath)).is_none());
    }
}
