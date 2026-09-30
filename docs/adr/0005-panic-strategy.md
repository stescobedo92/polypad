# ADR-0005: Keep `panic = "unwind"` in the application

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

The spec suggests `panic = "abort"` for binaries. The main process will host long-lived
tokio tasks — the kernel supervisor, the LSP broker, database sessions — and one of its core
principles is that nothing the user does can bring the application down.

With `abort`, a panic anywhere (including inside a dependency) terminates the whole process.
With `unwind`, a panic inside a spawned tokio task is caught by the runtime and surfaces as a
`JoinError`, which the supervisor can log and recover from (restart the task, report the error).

## Decision

The release profile keeps the default `panic = "unwind"`. Workspace lints still deny `panic!`,
`unwrap` and `expect` in production code, so panics remain bugs; unwinding only limits their
blast radius. User code never runs in this process anyway (kernels are separate processes).

## Consequences

- Slightly larger binary than with `abort`.
- Every long-lived task must be spawned so that its `JoinHandle` is observed (a supervisor
  pattern), otherwise a caught panic would go unnoticed. This is a review item from Phase 2.
- Small standalone Rust helper binaries, if any appear later, may use `abort`.
