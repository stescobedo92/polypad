# ADR-0004: Toolchain and build setup

- **Status:** Accepted
- **Date:** 2026-09-30

## Context

The monorepo mixes a Cargo workspace, a Tauri app and a Vite frontend, and must build
identically on Windows, macOS and Linux, locally and in CI.

## Decision

- **Rust** is pinned by `rust-toolchain.toml`. Workspace lints forbid `unsafe`, enable clippy
  `pedantic` and deny `unwrap`/`expect`/`panic`/`todo`/`dbg!`/`print*` outside tests
  (`clippy.toml` relaxes them in tests only), so production-path rules are compiler-enforced.
- **pnpm** workspace (`pnpm-workspace.yaml`) with the version pinned in `packageManager`.
- **Tauri CLI** is a pinned devDependency (`@tauri-apps/cli`), used as `pnpm tauri …`. A global
  `cargo tauri` may be a different major version (v1 was found on a development machine).
- **TypeScript 6.0**, not 7.0: TypeScript 7 (the native compiler) is `latest` on npm, but
  `typescript-eslint` supports `<6.1`, and type-aware linting is a hard requirement.
- **Vite build target**: Vite's default (Baseline Widely Available: Chrome 111, Safari 16.4)
  instead of the `safari13` suggested by Tauri's guide, because Tailwind CSS v4 itself requires
  Safari 16.4+. Effective floor: WebView2 (evergreen) on Windows, macOS with Safari 16.4+,
  WebKitGTK 4.1 on Linux.
- **Fonts** are self-hosted through Fontsource. Iosevka was rejected after measuring ~1 MB per
  weight (about 9 MB in total); Victor Mono is narrow as well and costs about 330 KB for all
  subsets and weights.
- **Windows test executables**: tauri-build embeds the application manifest (Common Controls
  v6) in a resource linked only into binaries, so unit tests crashed with
  `STATUS_ENTRYPOINT_NOT_FOUND`. `src-tauri/build.rs` disables that resource manifest and embeds
  the same manifest (`src-tauri/windows/app.manifest`) through linker arguments, which apply to
  tests and binaries alike (the same technique the `tauri` crate uses for its own tests).
- **Telemetry** is initialized after `tauri::Builder::build` and before `App::run_return`, not in
  the `setup` hook: a failing setup hook panics inside the event loop, and `App::run` exits the
  process without running destructors, which would lose buffered log records.
  - A failure to open the log file is not fatal: logging falls back to stderr.
  - A panic hook appends a crash report (message and backtrace) to `polypad-crash.log`
    **synchronously** before anything else. Panics raised inside the windowing system's callbacks
    (for example, window creation failing because WebView2 is missing) abort the process, which
    would drop records still queued in the non-blocking writer.
  - Known gap: if the Tauri runtime itself cannot be built, the error only goes to stderr, which
    Windows release builds do not have. A native error dialog for that case is deferred to the
    installer work in Phase 8 (installers also guarantee the WebView2 runtime).

## Consequences

- Upgrading to TypeScript 7 waits for typescript-eslint support.
- Contributors need Node 24+, pnpm (via Corepack or standalone) and the Rust toolchain; the
  pinned versions install automatically.
