# ADR-0009: Versioning and the release pipeline

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

PolyPad had no way to produce installers and no rule for choosing a version number. The spec
schedules signed installers and the updater for Phase 8, but testers need builds before that,
and a version number has to mean something from the first release on.

The repository already requires Conventional Commits (CONTRIBUTING.md): every commit states
whether it fixes something, adds something or breaks something. That is exactly the input
[Semantic Versioning 2.0.0](https://semver.org/) needs.

## Decision

**Versions are computed, not chosen.** [release-please](https://github.com/googleapis/release-please)
reads the Conventional Commits since the last release and keeps a release pull request up to
date with the next version and `CHANGELOG.md`. Merging it is the act of releasing. Rejected:

- *A tag pushed by hand and validated by the pipeline.* Simpler, but a person picks the number
  and writes the changelog, which is where SemVer discipline erodes.
- *A manual workflow that commits the bump to `main`.* No review, and incompatible with branch
  protection.
- *semantic-release.* It publishes on every push; a desktop app wants to batch changes.

**One version for the whole workspace**, held in `[workspace.package].version` of `Cargo.toml`.
Tauri reads it for the installers (`tauri.conf.json` deliberately has no `version`) and the app
reports it through `CARGO_PKG_VERSION`. While the major is 0, a breaking change raises the
minor (`bump-minor-pre-major`).

**release-please's `simple` strategy with `extra-files`.** Its `rust` strategy needs a
`[package]` table in the root manifest and does not expand `members = ["crates/*"]`. Three
explicit updaters replace it: the workspace version, `ui/package.json`, and in `Cargo.lock`
every package without a `source`, which is how Cargo records the members of the workspace.

**Tags are `vX.Y.Z`; the release is titled `polypad-vX.Y.Z` and every asset starts with that
title, followed by the platform:** `polypad-v1.2.3-windows-x64-setup.exe`,
`polypad-v1.2.3-macos-arm64.dmg`, `polypad-v1.2.3-linux-x64.AppImage`. The platform never goes
in the tag or the version, because SemVer reads everything after a hyphen as a pre-release:
`1.2.3-windows` would sort *before* `1.2.3`. One release holds all platforms.

**Draft first, publish last.** release-please creates the tag (`force-tag-creation`) and a
draft release. The installers are built, checked against the expected set and attached; only
then is the draft published. A platform that fails to build publishes nothing, and the publish
job refuses to touch a release that is no longer a draft.

**Least privilege.** The workflow token has no permissions by default. Builds run with
`contents: read`; only the release-please job and the publish job can write.

**Installers are built from a clean runner with `--locked`,** by the pinned Tauri CLI. No
cache is restored, so nothing a pull request wrote can reach a release. `tauri-action` is not
used: `scripts/release/` names the assets, the build needs no write access, and there is one
less third-party action to pin.

**No code signing yet.** macOS bundles are signed ad hoc (`signingIdentity: "-"`), without
which Apple Silicon reports a downloaded app as damaged. Each release carries a SHA-256
checksums file and a build provenance attestation, so a download can be traced to the
workflow run that built it. `bundle.publisher` is set because its default is the second
segment of the identifier, which is `github`.

## Consequences

- Commit messages are now part of the release interface: the type decides the version and the
  subject becomes the changelog line. `feat` and `fix` are for changes a user can notice.
- The repository setting "Allow GitHub Actions to create and approve pull requests" must stay
  enabled.
- Pull requests opened with `GITHUB_TOKEN` trigger no workflows, so the release job starts CI
  on the release branch through `workflow_dispatch`.
- The first release is `0.1.0`: the manifest starts at `0.0.0`, which release-please reads as
  "never released", and `initial-version` supplies the number.
- A pre-release (`Release-As: 1.0.0-beta.1`) ships no `.msi`: Windows Installer versions are
  numeric and Tauri rejects other pre-release identifiers.
- A path dependency that does not use the workspace version would get the wrong version in
  `Cargo.lock`; the `--locked` builds of CI on the release pull request catch it.
- Until Phase 8, Windows shows SmartScreen and macOS asks the user to allow the app. The
  updater, its signing keys and ARM builds for Windows and Linux remain open.
- Adding a platform means one entry in `scripts/release/assets.mjs` and one row in the workflow
  matrix; a test fails if they disagree.
