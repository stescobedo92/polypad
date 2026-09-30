# Language kernels

Each supported language runs in its own out-of-process kernel that speaks the PolyPad kernel
protocol (JSON-RPC 2.0 over stdio with `Content-Length` framing; see
`docs/spec/polypad-spec.md`, section 4). A crash or infinite loop in user code can only take
down its kernel, never the application.

Planned kernels, one directory each:

| Directory | Languages | Engine | Phase |
|---|---|---|---|
| `node/` | TypeScript, JavaScript | Node LTS + esbuild | 2 |
| `dotnet/` | C#, F# | Roslyn Scripting / FSharp.Compiler.Service | 3, 5 |
| `jvm/` | Java, Kotlin | JShell API / Kotlin scripting | 5 |
| `go/` | Go | temporary module + `go run` | 5 |
| `python/` | Python | CPython 3.11+ | 5 |
| `rust/` | Rust | evcxr | 5 |

SQL is executed directly by `crates/polypad-db`, without a kernel.
