//! Wire types and versioning for the PolyPad kernel protocol.
//!
//! Kernels are out-of-process language workers that speak JSON-RPC 2.0 over stdio with
//! `Content-Length` framing (see `docs/spec/polypad-spec.md`, section 4). The message and
//! `DumpNode` types arrive in Phase 2; for now the crate only pins the protocol version that
//! the handshake will negotiate.

/// Protocol version sent by the core in the `initialize` handshake.
pub const PROTOCOL_VERSION: &str = "1.0";
