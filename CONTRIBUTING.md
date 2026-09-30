# Contributing to PolyPad

## Prerequisites

- Rust (the pinned version in `rust-toolchain.toml` installs automatically through rustup)
- Node.js 24+ and pnpm (`corepack enable`, or install pnpm standalone)
- Platform requirements for Tauri 2: <https://tauri.app/start/prerequisites/>
  (WebView2 and the MSVC build tools on Windows, Xcode command line tools on macOS,
  WebKitGTK 4.1 on Linux)

## Everyday commands

| Task | Command |
|---|---|
| Install JS dependencies | `pnpm install` |
| Run the app with hot reload | `pnpm tauri dev` |
| Build a release binary | `pnpm tauri build --no-bundle` |
| Rust lint / test | `cargo clippy --workspace --all-targets -- -D warnings` · `cargo nextest run --workspace` |
| Frontend checks | `pnpm ui:check` (typecheck, lint, format, tests) |
| Regenerate IPC bindings | `pnpm bindings` |
| Dependency policy | `cargo deny check` · `cargo audit` |

Use the pinned Tauri CLI through `pnpm tauri`, not a globally installed `cargo tauri`.
Set `POLYPAD_LOG` (for example `POLYPAD_LOG=polypad=debug`) to change the log filter. Logs, and
`polypad-crash.log` after a panic, are written to the app's log directory:

| OS | Log directory |
|---|---|
| Windows | `%LOCALAPPDATA%\io.github.stescobedo92.polypad\logs` |
| macOS | `~/Library/Logs/io.github.stescobedo92.polypad` |
| Linux | `~/.local/share/io.github.stescobedo92.polypad/logs` |

## Adding a Tauri command

1. Write the function in `src-tauri/src/commands.rs` with `#[tauri::command]` and
   `#[specta::specta]`; keep it a thin adapter over a library crate.
2. Return `Result<T, CommandError>` if it can fail (never send raw error text to the UI).
3. Register it in `collect_commands!` in `src-tauri/src/ipc.rs`.
4. Add its name to `APP_COMMANDS` in `src-tauri/build.rs`.
5. Grant `allow-<command-name>` in the capability of each window that needs it, and justify
   the permission in the pull request (docs/adr/0003).
6. Run `pnpm bindings` and expose a named wrapper in `ui/src/shared/ipc/index.ts`.

## Adding a language kernel

The kernel protocol and the reference kernel arrive in Phase 2; this section will then describe
how to add a kernel in at most ten steps.

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope,
  e.g. `feat(kernel-csharp): …`, `fix(ui): …`. Keep them small.
- Branches: `feat/…`, `fix/…`, `chore/…`, `refactor/…`.
- No warnings: `clippy -D warnings`, `eslint --max-warnings 0`, strict `tsc`.
- No `unwrap`/`expect`/`panic!` in production code (enforced by workspace lints), no `any` in
  TypeScript, and all user-facing text goes through i18n keys in both `en` and `es`.
- Significant decisions get an ADR in `docs/adr/`.
