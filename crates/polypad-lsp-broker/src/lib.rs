//! Multiplexing proxy between the WebView and per-language LSP servers.
//!
//! Responsibilities (Phase 6): one language server per language shared across script tabs,
//! virtual document URIs, and position mapping for the prelude injected before each snippet.
