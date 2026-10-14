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
| Release script tests | `pnpm release:test` |

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

## Releasing

Versions follow [SemVer](https://semver.org/) and are derived from the commit history
(docs/adr/0009); nobody edits a version number by hand.

1. Merge work into `main` as usual. The **Release** workflow keeps a pull request titled
   `chore(main): release X.Y.Z` up to date with the next version and `CHANGELOG.md`.
2. To ship, check that pull request (CI runs on its branch) and merge it.
3. The workflow tags `vX.Y.Z`, builds the installers for every platform and publishes the
   release `polypad-vX.Y.Z`. The release stays a draft until the last installer is attached.

| Commit | Effect on the version |
|---|---|
| `fix: …` | patch: `0.2.0` → `0.2.1` |
| `feat: …` | minor: `0.2.1` → `0.3.0` |
| `feat!: …`, or a `BREAKING CHANGE:` footer | major; minor while the version is `0.x` |
| `docs`, `chore`, `refactor`, `test`, `ci`, `build` | none, and no changelog entry |

- **Pre-release:** force the version with a footer; it is published as a GitHub pre-release
  and ships no `.msi`.
  `git commit --allow-empty -m "chore: release 0.3.0-beta.1" -m "Release-As: 0.3.0-beta.1"`
- **Dry run:** a pull request that touches the packaging builds every installer without
  publishing, and so does `gh workflow run release.yml --ref <branch>`. The installers are
  attached to the run as artifacts.
- **A build failed during a release:** fix the cause and choose *Re-run failed jobs* on that
  run; *Re-run all jobs* would find nothing left to release. If the run has expired, start the
  workflow by hand with the tag of the draft release.
- **A new platform:** add it to `PLATFORMS` in `scripts/release/assets.mjs` and to the matrix in
  `.github/workflows/release.yml`.

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope,
  e.g. `feat(kernel-csharp): …`, `fix(ui): …`. Keep them small.
- Branches: `feat/…`, `fix/…`, `chore/…`, `refactor/…`.
- No warnings: `clippy -D warnings`, `eslint --max-warnings 0`, strict `tsc`.
- No `unwrap`/`expect`/`panic!` in production code (enforced by workspace lints), no `any` in
  TypeScript, and all user-facing text goes through i18n keys in both `en` and `es`.
- Significant decisions get an ADR in `docs/adr/`.
