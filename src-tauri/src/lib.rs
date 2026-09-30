//! PolyPad desktop application: wires the Tauri runtime to the `polypad-*` crates.
//!
//! Commands are thin adapters that translate between IPC types and domain services; business
//! logic lives in the library crates so it can be tested without a WebView.

pub mod commands;
pub mod error;
pub mod ipc;

use std::{path::Path, process::ExitCode};

use polypad_core::telemetry::{self, TelemetryConfig, TelemetryGuard};
use tauri::Manager;

use crate::error::DisplayChain;

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
        .invoke_handler(ipc.invoke_handler())
        .build(tauri::generate_context!())?;
    ipc.mount_events(&app);

    // Set up here rather than in `Builder::setup`, whose failures panic inside the event loop.
    let log_dir = app.path().app_log_dir()?;
    let telemetry = start_telemetry(&log_dir);
    telemetry::install_panic_hook(log_dir);
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        "PolyPad started"
    );

    // `run_return` (unlike `run`) hands control back instead of calling `process::exit`, so
    // dropping the telemetry guard below flushes the last buffered log records.
    let exit_code = app.run_return(|_, _| {});
    tracing::info!(exit_code, "PolyPad exited");
    drop(telemetry);

    Ok(u8::try_from(exit_code).map_or(ExitCode::FAILURE, ExitCode::from))
}

/// Starts file logging, falling back to stderr: a logging problem must never block start-up.
fn start_telemetry(log_dir: &Path) -> Option<TelemetryGuard> {
    match telemetry::init(&TelemetryConfig::new(log_dir)) {
        Ok(guard) => Some(guard),
        Err(error) => {
            // The fallback can only fail if a subscriber is already installed, in which case
            // that subscriber receives the error record below.
            let _ = telemetry::init_stderr_only();
            tracing::error!(
                error = %DisplayChain(&error),
                log_dir = %log_dir.display(),
                "file logging is unavailable; logging to stderr only"
            );
            None
        }
    }
}

/// Reports a failure to create the Tauri runtime, which happens before logging exists.
///
/// Best effort: release builds on Windows have no console. Panics after this point are
/// recorded by the panic hook instead (see docs/adr/0004).
#[allow(clippy::print_stderr)] // no logger is available yet; stderr is the only channel left
fn report_startup_failure(error: &tauri::Error) {
    eprintln!("PolyPad failed to start: {}", DisplayChain(error));
}
