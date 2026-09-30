# ADR-0002: Generate the IPC contract with tauri-specta

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amended by:** ADR-0007 (typed command errors, exported constants)

## Context

The spec requires TypeScript types generated from Rust and forbids calling Tauri commands
outside typed wrappers. Two options were evaluated:

- **tauri-specta** (with `specta` / `specta-typescript`): generates types *and* one typed
  function per command, including `tauri::ipc::Channel<T>` arguments (needed for streaming
  execution output in Phase 2). Still a release candidate (`2.0.0-rc.25`).
- **ts-rs**: stable and mature, but only generates types; every `invoke` wrapper and Channel
  plumbing would be written and kept in sync by hand.

## Decision

Use tauri-specta.

- `specta`, `tauri-specta` and `specta-typescript` are pinned with `=` because release
  candidates may break between versions and the three must match.
- Commands and exported types are registered in one place, `src-tauri/src/ipc.rs`.
- The bindings are written to `ui/src/shared/ipc/bindings.ts` and **committed**. They are
  regenerated with `pnpm bindings`; the unit test `ipc::tests::committed_bindings_are_up_to_date`
  fails CI when they drift. Nothing writes to the source tree at application runtime.
- Only `ui/src/shared/ipc/**` may import `@tauri-apps/api`; ESLint's `no-restricted-imports`
  enforces it (tests may additionally import `@tauri-apps/api/mocks`).
- Fallible commands return `Result<T, CommandError>`. `CommandError` is serialized as
  `{ code, reference }` and never carries paths, secrets or user code; the cause is logged under
  the same reference.

## Consequences

- Adding a command touches four places: the function (`commands.rs`), `collect_commands!` in
  `ipc.rs`, `APP_COMMANDS` in `build.rs` (see ADR-0003) and a capability file.
- Upgrading tauri-specta requires reading its changelog and regenerating bindings.
- **Fallback:** if tauri-specta stalls or breaks, replace it with ts-rs for types and hand-written
  wrappers in `shared/ipc`; the rest of the UI is unaffected because it only imports
  `shared/ipc/index.ts`.
