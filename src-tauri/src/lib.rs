//! PolyPad desktop application: wires the Tauri runtime to the `polypad-*` crates.
//!
//! Commands are thin adapters that translate between IPC types and domain services; business
//! logic lives in the library crates so it can be tested without a WebView.

pub mod commands;
pub mod error;
pub mod ipc;

use std::process::ExitCode;

use polypad_core::telemetry::{self, TelemetryConfig, TelemetryError};
use tauri::Manager;

/// Failures that prevent the application from starting.
#[derive(Debug, thiserror::Error)]
enum StartupError {
    #[error("the Tauri runtime could not be initialized")]
    Tauri(#[from] tauri::Error),
    #[error("logging could not be initialized")]
    Telemetry(#[from] TelemetryError),
}

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

fn try_run() -> Result<ExitCode, StartupError> {
    let ipc = ipc::builder();
    let app = tauri::Builder::default()
        .invoke_handler(ipc.invoke_handler())
        .build(tauri::generate_context!())?;
    ipc.mount_events(&app);

    // Initialized here rather than in `Builder::setup`: a failing setup hook panics inside the
    // event loop, while this path reports the error and exits cleanly.
    let log_dir = app.path().app_log_dir()?;
    let telemetry = telemetry::init(&TelemetryConfig::new(log_dir))?;
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

/// Last-resort report for failures that happen before logging exists.
#[allow(clippy::print_stderr)] // no logger is available yet; stderr is the only channel left
fn report_startup_failure(error: &StartupError) {
    eprintln!("PolyPad failed to start: {error}");
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        eprintln!("  caused by: {cause}");
        source = cause.source();
    }
}
