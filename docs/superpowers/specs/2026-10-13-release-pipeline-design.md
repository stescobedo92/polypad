# Release pipeline and versioning: design

- **Status:** Approved in conversation, pending review of this document
- **Date:** 2026-10-13
- **Source:** user request of 2026-10-13; `docs/spec/polypad-spec.md` §6 "Fase 8", item 4

## 1. Goal

One pipeline that turns a merge into published installers for Windows, macOS and Linux, with
version numbers that follow [Semantic Versioning 2.0.0](https://semver.org/) by construction
instead of by discipline.

Done when:

1. Merging the release pull request publishes a GitHub Release named `polypad-vX.Y.Z` with one
   installer per platform, each named after the version and the platform it targets.
2. The version is derived from the Conventional Commits on `main`; nobody types a number.
3. Nothing is published unless every platform built; a failed build leaves no public trace.
4. A change to the packaging is exercised on every platform before it reaches `main`.

## 2. Decisions taken with the user

| Topic | Decision |
|---|---|
| Release layout | **One GitHub Release per version**, tag `vX.Y.Z`, title `polypad-vX.Y.Z`. The platform goes in each asset's file name, never in the version: SemVer reads everything after a hyphen as a pre-release. |
| Versioning | **release-please**: it keeps a release pull request up to date with the next version and the changelog; merging it tags and publishes. |

## 3. Non-goals

- Code signing certificates and notarization (Phase 8). macOS bundles are signed ad hoc so that
  Apple Silicon does not report the download as damaged; Windows shows SmartScreen.
- The auto-updater, its signing keys and release channels (Phase 8).
- ARM builds for Windows and Linux. Adding one is a new entry in the platform table.
- Publishing to package managers (winget, Homebrew, apt repositories).

## 4. Versioning

- **Single source of truth:** `[workspace.package].version` in `Cargo.toml`. Tauri reads it for
  the installers (`tauri.conf.json` has no `version`) and the app shows it through
  `CARGO_PKG_VERSION`. `Cargo.lock` and `ui/package.json` follow it.
- **Bump rules:** `fix` raises the patch, `feat` the minor, a breaking change (`!` or a
  `BREAKING CHANGE:` footer) the major. While the major is 0, a breaking change raises the minor.
- **First release:** `0.1.0`, the version already in the tree.
- **Pre-releases:** a `Release-As: X.Y.Z-beta.N` footer forces the version. Any version with a
  pre-release part is published as a GitHub pre-release and ships no `.msi`, because Windows
  Installer accepts only numeric pre-release identifiers.
- release-please's `rust` strategy cannot be used: it needs a `[package]` table in the root
  manifest and does not expand `members = ["crates/*"]`. The `simple` strategy with explicit
  `extra-files` edits the three files instead.

## 5. Assets

| Platform | Runner | Rust target | Assets (`polypad-vX.Y.Z-` + …) |
|---|---|---|---|
| `windows-x64` | `windows-latest` | `x86_64-pc-windows-msvc` | `windows-x64-setup.exe`, `windows-x64.msi` |
| `macos-arm64` | `macos-latest` | `aarch64-apple-darwin` | `macos-arm64.dmg` |
| `macos-x64` | `macos-latest` | `x86_64-apple-darwin` | `macos-x64.dmg` |
| `linux-x64` | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `linux-x64.AppImage`, `linux-x64.deb`, `linux-x64.rpm` |

Plus `polypad-vX.Y.Z-checksums.txt` (SHA-256, `sha256sum -c` format) and a build provenance
attestation covering every asset (`gh attestation verify`).

## 6. Workflow (`.github/workflows/release.yml`)

```
push to main ──► release-please ── opens or updates the release pull request
                      │             and starts CI on its branch
                      │ (the release pull request was merged)
                      ▼
                 tag vX.Y.Z + draft release
                      │
                      ▼
                 bundle × 4 platforms ── read-only token, clean build, --locked
                      │
                      ▼
                 publish ── verify the asset set, checksums, attestation,
                            upload, rename to polypad-vX.Y.Z, publish the draft

pull request touching the packaging, or manual run ──► bundle × 4 only (dry run)
```

- **release-please** is the only job that writes to the repository on an ordinary push.
  Pull requests opened with `GITHUB_TOKEN` do not trigger workflows, so the job starts `ci.yml`
  on the release branch through `workflow_dispatch`, the documented exception.
- **bundle** builds with the pinned Tauri CLI (`pnpm tauri build --target … --bundles …`), not
  `tauri-action`: asset names stay under our control, the build needs no write permission, and
  there is one less third-party action to pin.
- **publish** is the only job with `contents: write` during a release. The release stays a
  draft until all assets are attached, so a failed platform publishes nothing. Re-running the
  failed jobs resumes the same release.

## 7. Release scripts (`scripts/release/`)

Plain Node (`node:test`, no dependencies), the single definition of what a platform is:

- `assets.mjs`: pure functions. SemVer validation, the platform table, asset names.
- `cli.mjs`: three commands used by the workflow.
  - `plan`: checks the workspace version against the tag and prints the target and bundle list.
  - `collect`: copies each installer out of Tauri's bundle directory under its release name;
    fails when one is missing or ambiguous.
  - `checksums`: refuses to continue unless the directory holds exactly the expected assets,
    then writes the checksums file.

## 8. Other changes

- `src-tauri/tauri.conf.json`: `bundle.macOS.signingIdentity: "-"` and `bundle.publisher`
  (the default publisher is the second segment of the identifier, i.e. `github`).
- `ci.yml`: a job that runs the release script tests.
- `docs/adr/0009`, a "Releasing" section in `CONTRIBUTING.md`, install notes in `README.md`.
- Repository setting "Allow GitHub Actions to create and approve pull requests" must be on.

## 9. Verification

- Unit tests for the scripts, including a guard that the workflow matrix and the platform table
  list the same platforms.
- release-please's own updaters run locally against `Cargo.toml`, `Cargo.lock` and
  `ui/package.json`; the result must pass `cargo metadata --locked`.
- `actionlint` on both workflows.
- A local Windows build through the same commands the workflow runs.
- The pull request for this change triggers the dry run on all four platforms.
- Not verifiable before the first release: the publish job and release-please's live run.
