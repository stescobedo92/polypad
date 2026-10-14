# PolyPad

A polyglot code scratchpad for the desktop: write a snippet, press <kbd>F5</kbd>, and inspect rich,
navigable results. PolyPad targets C#, F#, Java, Kotlin, Go, TypeScript/JavaScript, Python, Rust
and SQL through out-of-process language kernels that share a single protocol.

> **Status:** early development. Phase 0 (foundations) delivers the application shell, the
> security baseline, typed IPC and CI; the window shows the layout but nothing runs yet. The
> editor and script files arrive in Phase 1, code execution in Phase 2.

## Install

Download the installer for your platform from the
[latest release](https://github.com/stescobedo92/polypad/releases/latest):

| Platform | Asset |
|---|---|
| Windows (x64) | `polypad-vX.Y.Z-windows-x64-setup.exe`, or the `.msi` |
| macOS (Apple Silicon) | `polypad-vX.Y.Z-macos-arm64.dmg` |
| macOS (Intel) | `polypad-vX.Y.Z-macos-x64.dmg` |
| Linux (x64) | `polypad-vX.Y.Z-linux-x64.AppImage`, `.deb` or `.rpm` |

The installers are not code-signed yet. Windows SmartScreen asks for confirmation (*More info*,
then *Run anyway*) and macOS asks you to allow the app under *System Settings → Privacy &
Security*. To check a download, compare it with `polypad-vX.Y.Z-checksums.txt` or run
`gh attestation verify <file> --repo stescobedo92/polypad`.

## Getting started

```sh
pnpm install
pnpm tauri dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for prerequisites and the full list of commands.

## Repository layout

| Path | Contents |
|---|---|
| `src-tauri/` | Tauri 2 application: commands, capabilities, configuration |
| `crates/` | Rust libraries: core domain, kernel protocol, kernel host, LSP broker, databases, packages, secrets |
| `ui/` | React 19 + TypeScript frontend |
| `kernels/` | Out-of-process language kernels |
| `samples/` | Example scripts per language |
| `scripts/` | Release tooling used by the workflows |
| `docs/spec/` | Product specification |
| `docs/adr/` | Architecture decision records |

## License

[MIT](LICENSE)
