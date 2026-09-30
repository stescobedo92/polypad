//! Spawning and supervision of out-of-process language kernels.
//!
//! Responsibilities (Phase 2): spawn kernels with `tokio::process`, frame JSON-RPC messages over
//! stdio, correlate requests and responses, enforce per-OS resource limits (Job Objects,
//! `setrlimit`, cgroups v2) and implement two-level cancellation (cooperative, then kill).
