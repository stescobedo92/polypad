//! Structured logging.
//!
//! Records are written to a daily-rotated file inside the application's log directory and, in
//! debug builds, mirrored to stderr. Logging policy: never record user code in full, connection
//! strings or any other secret; wrap sensitive values in `polypad_secrets::Redacted` so that
//! their `Debug`/`Display` output is safe by construction.

use std::{
    io::{self, Write as _},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use tracing_appender::{
    non_blocking::{NonBlocking, WorkerGuard},
    rolling::{self, InitError, Rotation},
};
use tracing_subscriber::{
    EnvFilter, Layer,
    filter::ParseError,
    fmt,
    layer::SubscriberExt,
    registry::LookupSpan,
    util::{SubscriberInitExt, TryInitError},
};

/// Environment variable that overrides the log filter, using `RUST_LOG` syntax.
pub const LOG_FILTER_ENV: &str = "POLYPAD_LOG";

/// Filter used when [`LOG_FILTER_ENV`] is unset or invalid.
pub const DEFAULT_FILTER: &str = "info";

/// Number of daily log files kept before the oldest one is deleted.
pub const DEFAULT_MAX_LOG_FILES: usize = 14;

/// File, next to the rotating logs, that the panic hook appends crash reports to.
pub const CRASH_FILE_NAME: &str = "polypad-crash.log";

const LOG_FILE_PREFIX: &str = "polypad";
const LOG_FILE_SUFFIX: &str = "log";

/// Settings for [`init`].
#[derive(Debug, Clone)]
pub struct TelemetryConfig {
    /// Directory that receives the rotated log files. Created when missing.
    pub log_dir: PathBuf,
    /// Number of daily files kept before the oldest one is deleted.
    pub max_log_files: usize,
    /// Mirror every record to stderr, which is useful while developing.
    pub mirror_to_stderr: bool,
}

impl TelemetryConfig {
    /// Default retention for `log_dir`; stderr mirroring is enabled in debug builds only.
    #[must_use]
    pub fn new(log_dir: impl Into<PathBuf>) -> Self {
        Self {
            log_dir: log_dir.into(),
            max_log_files: DEFAULT_MAX_LOG_FILES,
            mirror_to_stderr: cfg!(debug_assertions),
        }
    }
}

/// Reasons why [`init`] can fail.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum TelemetryError {
    /// The log directory did not exist and could not be created.
    #[error("could not create the log directory")]
    CreateLogDir(#[source] io::Error),
    /// The rolling log file could not be opened.
    #[error("could not open the rolling log file")]
    OpenLogFile(#[source] InitError),
    /// Another global `tracing` subscriber was installed first.
    #[error("a global tracing subscriber is already installed")]
    AlreadyInitialized(#[source] TryInitError),
}

/// Keeps the background log writer alive; dropping it flushes the records still buffered.
#[must_use = "dropping the guard stops the background log writer"]
#[derive(Debug)]
pub struct TelemetryGuard {
    _worker: WorkerGuard,
}

/// Installs the global `tracing` subscriber.
///
/// Keep the returned guard alive for the whole process lifetime and drop it on shutdown so the
/// last records reach the disk. An invalid [`LOG_FILTER_ENV`] value is not fatal: the default
/// filter is used and a warning is logged once the subscriber is running.
///
/// # Errors
///
/// Fails when the log directory or file cannot be created, or when a global subscriber is
/// already installed.
pub fn init(config: &TelemetryConfig) -> Result<TelemetryGuard, TelemetryError> {
    let (filter, rejected_filter) = resolve_filter(std::env::var(LOG_FILTER_ENV).ok().as_deref());
    let (writer, worker) = file_writer(config)?;
    let stderr_layer = config
        .mirror_to_stderr
        .then(|| fmt::layer().with_writer(io::stderr));

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer(writer))
        .with(stderr_layer)
        .try_init()
        .map_err(TelemetryError::AlreadyInitialized)?;

    if let Some(error) = rejected_filter {
        tracing::warn!(%error, "ignoring invalid {LOG_FILTER_ENV}; using \"{DEFAULT_FILTER}\"");
    }

    Ok(TelemetryGuard { _worker: worker })
}

/// Installs a subscriber that only writes to stderr.
///
/// Fallback for when [`init`] cannot open the log file: logging problems must never prevent
/// PolyPad from starting.
///
/// # Errors
///
/// Fails when a global subscriber is already installed.
pub fn init_stderr_only() -> Result<(), TelemetryError> {
    let (filter, _) = resolve_filter(std::env::var(LOG_FILTER_ENV).ok().as_deref());
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(io::stderr))
        .try_init()
        .map_err(TelemetryError::AlreadyInitialized)
}

/// Routes panics to the log and to a crash report in `log_dir`, then runs the previous hook.
///
/// The crash report is written synchronously and first: a panic that unwinds into the
/// windowing system's callbacks aborts the process, and records still queued in the
/// non-blocking log writer would be lost.
pub fn install_panic_hook(log_dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let report = crash_report(&info.to_string(), &backtrace.to_string(), unix_time());
        // Best effort by design: inside a panic hook there is nowhere left to report an I/O
        // error, and the tracing record below and the previous hook still run.
        let _ = append_crash_report(&log_dir.join(CRASH_FILE_NAME), &report);
        tracing::error!(panic = %info, "PolyPad panicked");
        previous(info);
    }));
}

fn crash_report(panic: &str, backtrace: &str, unix_time: u64) -> String {
    format!(
        "=== PolyPad {} panicked (unix time {unix_time}) ===\n{panic}\n\nBacktrace:\n{backtrace}\n",
        env!("CARGO_PKG_VERSION")
    )
}

fn append_crash_report(path: &Path, report: &str) -> io::Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(report.as_bytes())?;
    // Reach the disk before a possible abort.
    file.sync_all()
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Parses the filter override, falling back to [`DEFAULT_FILTER`] and reporting why.
fn resolve_filter(raw: Option<&str>) -> (EnvFilter, Option<ParseError>) {
    match raw.map(EnvFilter::try_new) {
        Some(Ok(filter)) => (filter, None),
        Some(Err(error)) => (EnvFilter::new(DEFAULT_FILTER), Some(error)),
        None => (EnvFilter::new(DEFAULT_FILTER), None),
    }
}

fn file_writer(config: &TelemetryConfig) -> Result<(NonBlocking, WorkerGuard), TelemetryError> {
    std::fs::create_dir_all(&config.log_dir).map_err(TelemetryError::CreateLogDir)?;
    let appender = rolling::Builder::new()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix(LOG_FILE_SUFFIX)
        .max_log_files(config.max_log_files)
        .build(&config.log_dir)
        .map_err(TelemetryError::OpenLogFile)?;
    Ok(tracing_appender::non_blocking(appender))
}

fn file_layer<S>(writer: NonBlocking) -> impl Layer<S>
where
    S: tracing::Subscriber + for<'span> LookupSpan<'span>,
{
    fmt::layer().with_writer(writer).with_ansi(false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tracing_subscriber::layer::SubscriberExt;

    use super::{
        CRASH_FILE_NAME, DEFAULT_FILTER, TelemetryConfig, append_crash_report, crash_report,
        file_layer, file_writer, resolve_filter,
    };

    #[test]
    fn crash_reports_are_appended_with_panic_and_backtrace() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join(CRASH_FILE_NAME);

        append_crash_report(&path, &crash_report("first boom", "frame 0", 1)).unwrap();
        append_crash_report(&path, &crash_report("second boom", "frame 1", 2)).unwrap();

        let contents = fs::read_to_string(&path).unwrap();
        let first = contents.find("first boom").unwrap();
        let second = contents.find("second boom").unwrap();
        assert!(first < second, "{contents}");
        assert!(contents.contains("unix time 2"), "{contents}");
        assert!(contents.contains("Backtrace:\nframe 1"), "{contents}");
    }

    #[test]
    fn records_reach_a_daily_file_in_a_freshly_created_directory() {
        let temp = tempfile::tempdir().unwrap();
        let log_dir = temp.path().join("nested").join("logs");
        let (writer, worker) = file_writer(&TelemetryConfig::new(&log_dir)).unwrap();

        let subscriber = tracing_subscriber::registry().with(file_layer(writer));
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(answer = 42, "telemetry smoke test");
        });
        drop(worker); // flushes the background writer

        let files: Vec<_> = fs::read_dir(&log_dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        assert_eq!(files.len(), 1);

        let file = &files[0];
        let name = file.file_name().unwrap().to_string_lossy();
        assert!(name.starts_with("polypad."), "{name}");
        assert_eq!(file.extension().and_then(|ext| ext.to_str()), Some("log"));

        let contents = fs::read_to_string(file).unwrap();
        assert!(contents.contains("telemetry smoke test"), "{contents}");
        assert!(contents.contains("answer=42"), "{contents}");
    }

    #[test]
    fn missing_filter_uses_the_default() {
        let (filter, rejected) = resolve_filter(None);

        assert!(rejected.is_none());
        assert_eq!(filter.to_string(), DEFAULT_FILTER);
    }

    #[test]
    fn valid_filter_is_honoured() {
        let (filter, rejected) = resolve_filter(Some("polypad=debug"));

        assert!(rejected.is_none());
        assert_eq!(filter.to_string(), "polypad=debug");
    }

    #[test]
    fn invalid_filter_falls_back_to_the_default_and_reports_why() {
        let (filter, rejected) = resolve_filter(Some("polypad=loud"));

        assert!(rejected.is_some());
        assert_eq!(filter.to_string(), DEFAULT_FILTER);
    }
}
