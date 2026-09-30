//! PolyPad domain logic.
//!
//! This crate must not depend on Tauri: the commands in `src-tauri` are thin adapters over the
//! services defined here, which keeps the logic testable without a WebView.

pub mod telemetry;
