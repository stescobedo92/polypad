# PolyPad

A polyglot code scratchpad for the desktop: write a snippet, press <kbd>F5</kbd>, and inspect rich,
navigable results. PolyPad targets C#, F#, Java, Kotlin, Go, TypeScript/JavaScript, Python, Rust
and SQL through out-of-process language kernels that share a single protocol.

> **Status:** early development. Phase 0 (foundations) delivers the application shell, the
> security baseline, typed IPC and CI; the window shows the layout but nothing runs yet. The
> editor and script files arrive in Phase 1, code execution in Phase 2.

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
| `docs/spec/` | Product specification |
| `docs/adr/` | Architecture decision records |

## License

[MIT](LICENSE)
