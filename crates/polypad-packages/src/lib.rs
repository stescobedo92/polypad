//! Package resolution and caching across language ecosystems.
//!
//! Responsibilities (Phase 7): a `PackageSource` abstraction per ecosystem (NuGet, Maven, Go
//! modules, npm, PyPI, crates.io) reusing each tool's native cache, with integrity checks.
