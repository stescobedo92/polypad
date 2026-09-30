# PROMPT — Construir "PolyPad": un scratchpad políglota estilo LINQPad con Tauri 2 + Rust

> Copia este documento completo como instrucción para tu agente de código (Claude Code, etc.).
> Está escrito en segunda persona dirigido al agente.

---

## 0. Rol, reglas no negociables y forma de trabajo

Actúas como **Staff/Senior Engineer** con experiencia en Rust, Tauri 2, compiladores/REPLs, protocolos IPC y UX de herramientas para desarrolladores. Vas a construir **PolyPad**, una aplicación de escritorio que replica la *experiencia funcional* de LINQPad (escribir un snippet, pulsar F5, ver resultados enriquecidos con `Dump()`, explorar bases de datos, gestionar paquetes) pero para **múltiples lenguajes**: C#, F#, Java, Kotlin, Go, TypeScript/JavaScript, Python, Rust y SQL, con arquitectura extensible para añadir más.

Reglas:

1. **Fuente de verdad = Context7.** Antes de implementar, refactorizar o usar una API de cualquier librería (Tauri, tokio, sqlx, tiberius, Monaco, monaco-languageclient, Roslyn, JShell, TanStack, etc.) consulta su documentación actual en Context7. No inventes APIs. Si Context7 y tu memoria difieren, gana Context7.
2. **Identidad propia.** No copies nombre, logotipo, iconos, textos, archivos ni formatos propietarios de LINQPad. Replica flujos y capacidades, no activos. El producto se llama PolyPad y su extensión de archivo es `.ppad`.
3. **Calidad de producción.** Código limpio, sin `unwrap()`/`expect()` en rutas de producción, sin `any` en TypeScript, errores tipados, sin warnings (`cargo clippy -- -D warnings`, `eslint --max-warnings 0`, `tsc --noEmit` estricto).
4. **Seguridad por defecto.** Mínimo privilegio en capabilities de Tauri, CSP estricta, secretos en el llavero del SO, ejecución de código de usuario siempre fuera del proceso principal.
5. **Revisión antes de entregar.** Al final de cada fase: autorrevisión (correctitud, seguridad, rendimiento, concurrencia, manejo de errores), tests en verde y checklist de aceptación cumplido.
6. **Git.** Commits pequeños con Conventional Commits (`feat(kernel-csharp): ...`). **Nunca** añadas trailers `Co-Authored-By`. **Nunca** uses el prefijo `codex` en ramas; usa `feat/…`, `fix/…`, `chore/…`, `refactor/…`.
7. **Trabajo incremental.** Sigue las fases en orden. No empieces una fase sin cerrar la anterior. Si una decisión es ambigua y costosa de revertir, detente y pregunta.

---

## 1. Visión del producto

| Capacidad LINQPad | Equivalente en PolyPad |
|---|---|
| Editor con IntelliSense, F5 para ejecutar | Monaco + LSP por lenguaje, F5 / Ctrl+Enter |
| Modos: Expression / Statements / Program | Modos por lenguaje: **Expression**, **Statements**, **Program**, **SQL** |
| `.Dump()` con tablas anidadas y expandibles | `dump()` universal en cada kernel → árbol `DumpNode` común → visor HTML virtualizado |
| Pestañas de resultado: Results, SQL, IL, Tree | Results, SQL generado, Salida IR (IL/bytecode/asm/JS transpilado), Syntax Tree, Log |
| Explorador de conexiones y data contexts tipados | Explorador de conexiones (PostgreSQL, SQL Server, MySQL, SQLite, más adelante MongoDB) con esquema navegable y generación de contexto tipado por lenguaje |
| NuGet manager | Gestor de paquetes unificado: NuGet, Maven, Go modules, npm, PyPI, crates.io |
| My Queries / Samples | Árbol de scripts del usuario + samples incluidos por lenguaje |
| `Util.Cmd`, `Util.Progress`, `Util.ReadLine` | API `PolyPad.*` equivalente por lenguaje (progreso, input, HTML crudo, gráficos) |
| Cancelar ejecución | Cancelación cooperativa + kill forzado del proceso kernel |

**No objetivos del MVP:** depurador paso a paso, colaboración en tiempo real, sincronización en la nube.

---

## 2. Arquitectura

### 2.1 Visión general

```
┌──────────────────────────────── Tauri 2 (proceso principal, Rust) ────────────────────────────────┐
│                                                                                                     │
│  WebView (React + TS)  ◄── invoke / ipc::Channel ──►  Commands (thin)                               │
│                                                          │                                          │
│                                                          ▼                                          │
│                                       polypad-core (dominio, sin dependencia de Tauri)              │
│   ┌──────────────┬──────────────────┬───────────────────┬──────────────────┬──────────────────┐     │
│   │ Workspace &  │ Kernel Supervisor│ LSP Broker        │ Connections &    │ Package Resolver │     │
│   │ Script Store │ (spawn, health,  │ (1 server/lang,   │ Schema Explorer  │ (NuGet, Maven,   │     │
│   │ (.ppad, fs)  │  cancel, limits) │  multiplexado)    │ (sqlx, tiberius) │  npm, go, pip)   │     │
│   └──────────────┴────────┬─────────┴─────────┬─────────┴──────────────────┴──────────────────┘     │
└───────────────────────────┼───────────────────┼─────────────────────────────────────────────────────┘
                            │ stdio JSON-RPC    │ stdio LSP
              ┌─────────────┼─────────────┐     ├──────────────┬───────────────┬──────────────┐
              ▼             ▼             ▼     ▼              ▼               ▼              ▼
        kernel-dotnet  kernel-jvm   kernel-go  csharp-ls     jdtls          gopls     typescript-language-server …
        (Roslyn        (JShell API) (go run /
         Scripting)                  yaegi)    kernel-node (TS vía esbuild/tsx) · kernel-python · kernel-rust (evcxr) …
```

### 2.2 Principios clave

- **Kernels fuera de proceso.** Cada lenguaje corre en un proceso hijo ("kernel") propio, nunca dentro del proceso Tauri. Un crash o bucle infinito del usuario jamás tumba la app.
- **Protocolo único** entre core y kernels (sección 4), inspirado en Jupyter/LSP: JSON-RPC 2.0 sobre stdio con framing `Content-Length`. Así añadir un lenguaje = implementar un kernel, sin tocar la UI.
- **Kernels calientes.** Un pool mantiene un kernel precalentado por lenguaje para que F5 responda en < 300 ms (tras el primer arranque).
- **`polypad-core` independiente de Tauri.** Toda la lógica vive en crates de librería testeables; los `#[tauri::command]` son adaptadores finos.
- **Streaming con `tauri::ipc::Channel`**, no con eventos globales, para salida de ejecución y resultados de `dump` (los eventos de Tauri no están pensados para alto throughput; los Channels sí).

### 2.3 Estructura del repositorio (monorepo)

```
polypad/
├─ Cargo.toml                    # [workspace] con resolver = "2", perfiles release optimizados
├─ crates/
│  ├─ polypad-core/              # dominio: scripts, sesiones, supervisor, errores
│  ├─ polypad-protocol/          # tipos del protocolo kernel (serde), versionado, + generación de tipos TS
│  ├─ polypad-kernel-host/       # spawn, límites de recursos, framing stdio, cancelación
│  ├─ polypad-lsp-broker/        # proxy LSP multiplexado hacia el WebView
│  ├─ polypad-db/                # conexiones, introspección de esquema, ejecución SQL
│  ├─ polypad-packages/          # resolución y caché de paquetes por ecosistema
│  └─ polypad-secrets/           # wrapper sobre `keyring`
├─ src-tauri/                    # app Tauri 2: commands, capabilities/, tauri.conf.json
├─ kernels/
│  ├─ dotnet/                    # C#/F# — proyecto .NET 8+ (Roslyn Scripting)
│  ├─ jvm/                       # Java/Kotlin — JShell API (jdk.jshell) / Kotlin scripting
│  ├─ go/                        # Go — generador de módulo temporal + `go run`, modo rápido con yaegi
│  ├─ node/                      # TS/JS — Node LTS + esbuild (transpilación en memoria)
│  ├─ python/                    # Python 3.11+
│  └─ rust/                      # Rust — evcxr
├─ ui/                           # React 19 + TypeScript + Vite
│  ├─ src/app/ …                 # shell, layout, rutas
│  ├─ src/features/editor/       # Monaco + LSP client
│  ├─ src/features/results/      # visor de DumpNode virtualizado
│  ├─ src/features/explorer/     # conexiones y árbol de scripts
│  ├─ src/features/packages/
│  ├─ src/shared/ipc/            # wrappers tipados sobre invoke/Channel (tipos generados)
│  └─ src/shared/ui/             # design system propio
├─ samples/                      # scripts de ejemplo por lenguaje
└─ docs/adr/                     # Architecture Decision Records
```

### 2.4 Stack recomendado (verifica versiones actuales en Context7)

**Rust:** `tauri` 2.x, `tokio` (rt-multi-thread), `serde`/`serde_json`, `thiserror` (librerías) + `anyhow` sólo en binarios, `tracing` + `tracing-subscriber`, `sqlx` (Postgres/MySQL/SQLite, feature `runtime-tokio`, TLS rustls), `tiberius` (SQL Server), `keyring`, `notify` (watch de archivos), `which` (detección de toolchains), `specta`/`tauri-specta` o `ts-rs` para generar tipos TS desde Rust, `uuid`, `dashmap` o `tokio::sync` según el caso.

**Frontend:** React 19, TypeScript estricto, Vite, `monaco-editor` + `monaco-languageclient`, Zustand (estado de UI) + TanStack Query (estado remoto/async), TanStack Table + TanStack Virtual (resultados grandes), `react-resizable-panels`, Radix UI primitives, Tailwind CSS, Vitest + Testing Library.

**Plugins Tauri (sólo los necesarios):** `dialog`, `fs` (con scopes acotados), `store` o persistencia propia, `updater`, `window-state`, `single-instance`, `log`. **No** uses el plugin `shell` para ejecutar kernels desde JS: el spawn se hace exclusivamente desde Rust.

---

## 3. Ejemplos de UI

Diseño denso, orientado a teclado, tema oscuro y claro, tipografía monoespaciada para código y resultados. Todas las regiones redimensionables y colapsables; el layout se persiste.

### 3.1 Ventana principal

```
┌─ PolyPad ──────────────────────────────────────────────────────────────────────────────────────┐
│ File  Edit  Query  View  Tools  Help                                                            │
├──────────────────────┬─────────────────────────────────────────────────────────────────────────┤
│ CONNECTIONS      [+] │ [orders.ppad ●] [scratch-go.ppad] [+]                                   │
│ ▾ 🐘 prod-replica    │ ┌───────────────────────────────────────────────────────────────────────┐│
│   ▾ public           │ │ Language [C# ▾]  Mode [Statements ▾]  Connection [prod-replica ▾]     ││
│     ▸ customers      │ │ Packages [2]  ▶ Run (F5)  ■ Stop (Shift+F5)   ⏱ 00:00.184             ││
│     ▸ orders         │ ├───────────────────────────────────────────────────────────────────────┤│
│     ▸ order_items    │ │  1  var top = Orders                                                  ││
│ ▸ 🗄 local.sqlite    │ │  2      .Where(o => o.Total > 500)                                    ││
│ ▸ 🟦 mssql-dev       │ │  3      .OrderByDescending(o => o.CreatedAt)                          ││
│                      │ │  4      .Take(20);                                                    ││
│ MY SCRIPTS       [⌕] │ │  5                                                                    ││
│ ▾ 📁 reports         │ │  6  top.Dump("Top orders");                                           ││
│   · orders.ppad      │ │  7  top.Sum(o => o.Total).Dump("Total");                              ││
│   · churn.ppad       │ │                                                                       ││
│ ▾ 📁 go-experiments  │ ├═══════════════════════════ (splitter) ════════════════════════════════┤│
│   · scratch-go.ppad  │ │ [Results] [SQL] [IR] [Tree] [Log]                        ⤢  ⎘  ⇩     ││
│                      │ │ ▾ Top orders — List<Order> (20 items)                                 ││
│ SAMPLES              │ │ ┌──────┬────────────┬──────────┬─────────────────────┬─────────────┐  ││
│ ▸ C#  ▸ Java  ▸ Go   │ │ │ Id   │ CustomerId │  Total   │ CreatedAt           │ Items       │  ││
│ ▸ TypeScript ▸ SQL   │ │ ├──────┼────────────┼──────────┼─────────────────────┼─────────────┤  ││
│                      │ │ │ 9812 │ 331        │ 1,240.00 │ 2026-09-29 18:02:11 │ ▸ List (3)  │  ││
│                      │ │ │ 9790 │ 12         │   980.50 │ 2026-09-29 16:44:03 │ ▸ List (1)  │  ││
│                      │ │ │ …    │            │          │                     │             │  ││
│                      │ │ └──────┴────────────┴──────────┴─────────────────────┴─────────────┘  ││
│                      │ │                                               Σ Total  18,442.75      ││
│                      │ │ ▾ Total — decimal                                                     ││
│                      │ │   18442.75                                                            ││
│                      │ └───────────────────────────────────────────────────────────────────────┘│
├──────────────────────┴─────────────────────────────────────────────────────────────────────────┤
│ ● .NET 8 kernel ready │ C# 12 · Statements │ prod-replica (read-only) │ Ln 6, Col 18 │ UTF-8   │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Visor de `dump` — reglas de render

```
▾ Customer                                     ← objeto: tabla de 2 columnas (propiedad | valor)
  ┌─────────────┬──────────────────────────┐
  │ Id          │ 331                      │
  │ Name        │ "Ada Lovelace"           │
  │ Email       │ null                     │   ← null en gris itálica
  │ Address     │ ▸ Address                │   ← objeto anidado colapsado (carga perezosa)
  │ Orders      │ ▸ List<Order> (1,204)    │   ← colección grande: página de 1,000 + "cargar más"
  │ Self        │ ↻ ciclo → Customer#1     │   ← referencia cíclica detectada
  └─────────────┴──────────────────────────┘
▾ int[] (5)                                    ← colección de primitivos: lista vertical
  1 · 2 · 3 · 5 · 8
▾ Exception: InvalidOperationException          ← excepción: banda roja, mensaje, stack plegable
```

Reglas: colecciones homogéneas de objetos → tabla con columnas por propiedad; numéricos alineados a la derecha con suma opcional al pie; profundidad inicial de expansión configurable (por defecto 3); nodos más profundos se piden bajo demanda al kernel por `handle`; virtualización a partir de 200 filas; exportar a CSV/JSON/Excel; copiar celda/fila/tabla.

### 3.3 Diálogo de nueva conexión

```
┌─ New Connection ───────────────────────────────────────────────┐
│ Provider    ( ) PostgreSQL  ( ) SQL Server  ( ) MySQL  ( ) SQLite │
│ Name        [ prod-replica                                   ] │
│ Host        [ db.internal ]  Port [ 5432 ]                     │
│ Database    [ shop        ]                                    │
│ Auth        [ Username/Password ▾ ]                            │
│ User        [ reader      ]  Password [ •••••••• ] (keychain)  │
│ TLS         [x] Require   [ ] Trust server cert                │
│ Options     [x] Read-only session   Timeout [ 30 ] s           │
│                                                                │
│ [ Test ]  ✓ Connected in 42 ms — PostgreSQL 16.4    [Cancel] [Save] │
└────────────────────────────────────────────────────────────────┘
```

### 3.4 Gestor de paquetes

```
┌─ Packages — orders.ppad (C#) ────────────────────────────────────┐
│ Source [ NuGet ▾ ]  Search [ dapper                          ] ⌕ │
│ ┌──────────────────────────────┬─────────┬──────────────────────┐ │
│ │ Dapper                       │ 2.x.x   │ [ Add ]              │ │
│ │ Dapper.Contrib               │ 2.x.x   │ [ Add ]              │ │
│ └──────────────────────────────┴─────────┴──────────────────────┘ │
│ In this script:  Newtonsoft.Json 13.x  [×]    Humanizer 2.x [×]  │
│ [ ] Add to default imports for all C# scripts            [Close] │
└──────────────────────────────────────────────────────────────────┘
```

### 3.5 Atajos de teclado (configurables)

| Acción | Atajo |
|---|---|
| Ejecutar todo / selección | F5 · Ctrl+Enter |
| Cancelar | Shift+F5 |
| Nuevo script (mismo lenguaje) | Ctrl+N |
| Cambiar lenguaje | Ctrl+Shift+L |
| Paleta de comandos | Ctrl+Shift+P |
| Buscar script | Ctrl+P |
| Alternar panel de resultados | Ctrl+R |
| Ir a pestaña SQL / IR | Ctrl+1 … Ctrl+5 |

### 3.6 Estados que la UI debe cubrir

Kernel arrancando (skeleton + "Warming up .NET…"), toolchain no encontrado (banner con instrucciones de instalación y botón "Locate…"), ejecución en curso (timer vivo, botón Stop activo), error de compilación (subrayado en editor + lista en pestaña Log, clic → salta a línea), excepción en runtime, cancelado, resultado vacío, conexión caída, sin conexión seleccionada en modo SQL.

---

## 4. Protocolo de kernels (`polypad-protocol`)

JSON-RPC 2.0 sobre stdio, framing `Content-Length: N\r\n\r\n<json>`. `stderr` del kernel se captura sólo como log de diagnóstico. Versionado explícito en el handshake.

### 4.1 Mensajes

```jsonc
// core → kernel
{ "jsonrpc":"2.0", "id":1, "method":"initialize",
  "params": { "protocolVersion":"1.0", "workspaceDir":"…", "limits":{ "maxDumpDepth":3, "maxRows":1000 } } }

{ "jsonrpc":"2.0", "id":2, "method":"execute",
  "params": { "executionId":"uuid", "language":"csharp", "mode":"statements",
              "code":"…", "packages":[{"source":"nuget","id":"Dapper","version":"2.1.35"}],
              "connection": { "id":"prod-replica", "kind":"postgres" },   // sin secretos: ver 4.3
              "imports":["System.Linq"] } }

{ "jsonrpc":"2.0", "method":"cancel", "params": { "executionId":"uuid" } }
{ "jsonrpc":"2.0", "id":3, "method":"expandNode", "params": { "handle":"h:42", "offset":0, "limit":200 } }
{ "jsonrpc":"2.0", "id":4, "method":"shutdown" }

// kernel → core (notificaciones durante la ejecución)
{ "jsonrpc":"2.0", "method":"output",      "params": { "executionId":"…", "stream":"stdout", "text":"…" } }
{ "jsonrpc":"2.0", "method":"dump",        "params": { "executionId":"…", "title":"Top orders", "node": { /* DumpNode */ } } }
{ "jsonrpc":"2.0", "method":"diagnostic",  "params": { "executionId":"…", "severity":"error", "message":"…", "range":{…} } }
{ "jsonrpc":"2.0", "method":"artifact",    "params": { "executionId":"…", "kind":"sql"|"il"|"bytecode"|"js"|"syntaxTree", "content":"…" } }
{ "jsonrpc":"2.0", "method":"progress",    "params": { "executionId":"…", "percent":42, "label":"…" } }

// respuesta final a "execute"
{ "jsonrpc":"2.0", "id":2, "result": { "status":"ok"|"error"|"cancelled", "elapsedMs":184 } }
```

### 4.2 `DumpNode` (esquema común a todos los lenguajes)

```ts
type DumpNode =
  | { kind: "null" }
  | { kind: "primitive"; type: string; value: string | number | boolean; display?: string }
  | { kind: "object"; type: string; id: number; members: { name: string; value: DumpNode }[]; truncated?: boolean }
  | { kind: "collection"; type: string; count: number | null; columns?: string[];
      items: DumpNode[]; handle?: string /* para paginar */ }
  | { kind: "ref"; targetId: number }                 // ciclo
  | { kind: "lazy"; type: string; handle: string }    // expandir bajo demanda
  | { kind: "error"; type: string; message: string; stack?: string }
  | { kind: "html"; html: string }                   // sanitizado en el front con DOMPurify
  | { kind: "chart"; spec: unknown };                // fase posterior
```

Cada kernel implementa un serializador con: detección de ciclos por identidad, límite de profundidad, límite de elementos, límite de bytes por mensaje (p. ej. 4 MB, el resto como `lazy`), y protección contra getters con efectos/excepciones (captura la excepción como nodo `error`, no aborta el dump). Los `handle` viven en una tabla del kernel liberada al iniciar la siguiente ejecución.

### 4.3 Reglas de seguridad del protocolo

- Los secretos de conexión **no** viajan en `execute`. El core entrega una cadena de conexión efímera por variable de entorno o por un mensaje `resolveConnection` que el kernel consume y descarta; nunca se escribe en disco ni en logs.
- El core valida tamaño y esquema de cada mensaje entrante; mensajes malformados → se registra y se reinicia el kernel.
- Timeouts por request; heartbeat cada 5 s; 3 fallos → kernel marcado como muerto y relanzado.

---

## 5. Kernels por lenguaje (estrategia concreta)

Para cada kernel: detectar toolchain (`which`, variables `JAVA_HOME`, `DOTNET_ROOT`, `GOROOT`), mensaje claro si falta, versión mínima documentada.

| Lenguaje | Motor de ejecución | Modos | `dump` | Artefactos | LSP |
|---|---|---|---|---|---|
| **C#** | .NET 8+ worker con `Microsoft.CodeAnalysis.CSharp.Scripting` (Roslyn). Programa: compilación en memoria con `CSharpCompilation` + `AssemblyLoadContext` coleccionable por ejecución | Expression, Statements, Program | Método de extensión `Dump<T>(this T, string? title = null)` que devuelve el mismo objeto (encadenable) | IL (vía `System.Reflection.Metadata`/ decompilador), SQL generado por EF Core (`ToQueryString()`), syntax tree | csharp-ls u OmniSharp |
| **F#** | FSharp.Compiler.Service (FSI embebido) | Expression, Script | `dump` / `|> dump` | — | fsautocomplete |
| **Java** | Worker JVM 21+ con API `jdk.jshell` (snippets) y `javax.tools` para modo Program | Expression, Statements, Program | `PolyPad.dump(obj)` + import estático | bytecode (`javap -c`) | jdtls |
| **Kotlin** | Kotlin scripting host (JSR-223 / `kotlin-scripting-jvm`) | Script | extensión `.dump()` | — | kotlin-language-server |
| **Go** | Modo preciso: genera módulo temporal (`go.mod` + `main.go` envolviendo el snippet) y ejecuta `go run` con `GOCACHE` persistente. Modo rápido opcional: `yaegi` | Statements, Program | `polypad.Dump(v)` vía `reflect` | asm (`go build -gcflags=-S`) | gopls |
| **TypeScript / JS** | Node LTS: transpila con esbuild en memoria y ejecuta en `vm` / worker_threads aislado; top-level await habilitado | Expression, Statements, Module | `dump(v)` global y `.dump()` vía helper | JS transpilado | typescript-language-server |
| **Python** | CPython 3.11+ con intérprete persistente por sesión | Expression, Script | `dump(v)`; integra pandas DataFrame como tabla | bytecode (`dis`) | pyright / basedpyright |
| **Rust** | `evcxr` como librería o binario | Statements | `dump!(v)` con `serde::Serialize` o `Debug` | — | rust-analyzer |
| **SQL** | Ejecutado por `polypad-db` directamente en Rust (sin kernel) | SQL | Resultado tabular nativo | Plan de ejecución (EXPLAIN) | sqls (opcional) |

**Data contexts tipados:** al asociar una conexión a un script C#, el core genera (y cachea por hash de esquema) un modelo EF Core scaffoldeado y lo inyecta como `this` del script, de forma que `Orders.Where(...)` funciona como en LINQPad. Equivalentes posteriores: jOOQ/JDBC records en Java, `sqlc`-style structs en Go, Kysely/Drizzle types en TS.

---

## 6. Plan de implementación paso a paso

Cada fase termina con: tests pasando, clippy/eslint limpios, autorrevisión escrita en el PR, y el checklist de aceptación verificado manualmente.

### Fase 0 — Fundaciones (día 1–2)
1. Consulta en Context7 la guía actual de creación de proyectos Tauri 2 y crea el workspace con la estructura de §2.3.
2. Configura `Cargo.toml` del workspace: `resolver = "2"`, `[workspace.lints]` (`unsafe_code = "forbid"` salvo crates justificados, clippy `pedantic` como warn), perfil release con `lto = "thin"`, `codegen-units = 1`, `strip = true`, `panic = "abort"` sólo en binarios.
3. Frontend: Vite + React + TS con `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESLint flat config + Prettier.
4. Seguridad Tauri: CSP explícita y restrictiva en `tauri.conf.json` (`default-src 'self'`; permitir `worker-src blob:` y lo mínimo que Monaco requiera — verifícalo); capabilities en `src-tauri/capabilities/*.json` separadas por ventana, sólo permisos usados.
5. Generación de tipos TS desde Rust (tauri-specta o ts-rs) integrada en el build; el front **sólo** llama a comandos mediante estos wrappers tipados.
6. `tracing` con rotación de logs en el directorio de datos de la app; nunca loggear código del usuario completo ni secretos.
7. CI (GitHub Actions) con matriz Windows/macOS/Linux: fmt, clippy, `cargo nextest`, `cargo deny`, `cargo audit`, `tsc`, `eslint`, `vitest`.

✅ Aceptación: la app abre una ventana vacía con el layout de §3.1 (sin funcionalidad), CI verde en las 3 plataformas.

### Fase 1 — Shell de UI y editor
1. Layout con `react-resizable-panels`: explorador, pestañas de scripts, editor, resultados, barra de estado. Persistir tamaños con `window-state` + preferencias.
2. Integra Monaco cargando workers localmente (sin CDN, por CSP). Tema claro/oscuro sincronizado con el SO.
3. Modelo de documento `.ppad`: cabecera JSON (versión de formato, lenguaje, modo, conexión, paquetes, imports) + separador + código. Parser/serializador en Rust con tests de ida y vuelta y migraciones de versión.
4. Árbol "My Scripts" respaldado por una carpeta del usuario (configurable), con `notify` para reflejar cambios externos. Autosave con debounce y recuperación tras crash.
5. Paleta de comandos y atajos de §3.5.

✅ Aceptación: crear, renombrar, mover, guardar y reabrir scripts; cambios externos en disco se reflejan; sin pérdida de datos al matar la app.

### Fase 2 — Kernel host + primer kernel (TypeScript/JS)
1. `polypad-kernel-host`: spawn con `tokio::process::Command`, `kill_on_drop(true)`, stdio con framing, lector/escritor en tareas separadas, correlación request/response por `id` con `oneshot`.
2. Límites de recursos: Windows → Job Object (memoria, kill-on-close); Linux → `setrlimit` + cgroups v2 si disponibles; macOS → `setrlimit`. Timeout de ejecución configurable.
3. Cancelación en dos niveles: `cancel` cooperativo; si no responde en N ms, kill del proceso y relanzado transparente.
4. Supervisor con pool caliente de 1 kernel por lenguaje, health check y backoff exponencial en relanzados.
5. Comando Tauri `execute_script` que recibe un `Channel<ExecutionEvent>` y reenvía `output`, `dump`, `diagnostic`, `artifact`, `progress` y el estado final.
6. Kernel Node: transpilación esbuild, `dump()` global con el serializador de §4.2, captura de `console.*`.
7. Visor de resultados: render de `DumpNode` con TanStack Table + Virtual, expansión perezosa vía `expand_node`.

✅ Aceptación: `[1,2,3].map(x => ({x, sq: x*x})).dump()` muestra tabla; `while(true){}` se cancela con Shift+F5 en < 1 s; el kernel caído se relanza solo; 100k filas se desplazan a 60 fps.

### Fase 3 — Kernel C# (el más cercano a LINQPad)
1. Worker .NET con Roslyn Scripting para Expression/Statements y `CSharpCompilation` para Program; `AssemblyLoadContext` coleccionable para liberar memoria entre ejecuciones.
2. `Dump()` como extensión genérica encadenable; serializador por reflexión con caché de metadatos por tipo, soporte `IEnumerable`, `IAsyncEnumerable`, `Task`, `DataTable`, `JsonElement`.
3. Imports por defecto configurables; diagnósticos de Roslyn mapeados a rangos del editor.
4. Pestaña IR con IL; pestaña Tree con el syntax tree de Roslyn.

✅ Aceptación: paridad con los ejemplos de §7.1; errores de compilación subrayados en la línea correcta; 50 ejecuciones seguidas sin crecimiento sostenido de memoria.

### Fase 4 — Conexiones y SQL
1. `polypad-db`: trait `DatabaseProvider` (`test`, `introspect_schema`, `execute`, `explain`, `cancel`), implementaciones con `sqlx` (Postgres, MySQL, SQLite) y `tiberius` (SQL Server).
2. Secretos en `keyring`; el archivo de conexiones sólo guarda metadatos y un id de secreto.
3. Sesiones "read-only" reales (`SET TRANSACTION READ ONLY` / usuario de sólo lectura / `ApplicationIntent=ReadOnly`), aviso visual para conexiones de producción.
4. Explorador de esquema con carga perezosa (esquemas → tablas → columnas/índices/FKs); drag & drop de tabla al editor genera un snippet.
5. Modo SQL con resultados streameados por lotes y cancelación del statement en servidor.
6. Data context tipado para C# (scaffold EF Core cacheado por hash de esquema) y pestaña SQL con `ToQueryString()`.

✅ Aceptación: consultas parametrizadas siempre (nunca concatenación en código propio del core); cancelar una consulta larga la cancela en el servidor; ningún secreto aparece en logs, `.ppad` ni memoria persistida.

### Fase 5 — Java, Go, Python, Kotlin, F#, Rust
Implementa cada kernel siguiendo la tabla de §5, reutilizando el mismo test de conformidad del protocolo (suite compartida que todo kernel debe pasar: handshake, execute ok/error, dump de ciclo, colección grande paginada, cancelación, excepción en getter, salida Unicode).

✅ Aceptación: la suite de conformidad pasa en todos los kernels y en las 3 plataformas.

### Fase 6 — LSP e IntelliSense
1. `polypad-lsp-broker`: un servidor LSP por lenguaje, compartido entre pestañas; transporte WebView ↔ Rust por Channel; el broker reescribe URIs virtuales.
2. Documento virtual por script que antepone imports/data context para que el LSP entienda el snippet (mapeo de posiciones con offsets).
3. Completado, hover, firma, diagnósticos en vivo, go-to-definition dentro del script.

✅ Aceptación: completado de miembros del data context en C#; latencia de completado p95 < 150 ms en caliente.

### Fase 7 — Paquetes
1. Trait `PackageSource` por ecosistema con búsqueda, resolución de versiones y caché local compartida (reutiliza cachés nativos: `~/.nuget`, `~/.m2`, `GOMODCACHE`, etc.).
2. Resolución en background con progreso; el kernel recibe rutas ya resueltas.
3. Verificación de integridad (hashes que provee cada gestor); avisos de paquetes con vulnerabilidades conocidas si el ecosistema lo expone.

✅ Aceptación: añadir Dapper/Newtonsoft (C#), Guava (Java), `github.com/google/uuid` (Go), `lodash` (TS) y usarlos en el script.

### Fase 8 — Pulido, rendimiento y distribución
1. Samples por lenguaje, onboarding que detecta toolchains instalados.
2. Exportación de resultados (CSV, JSON, XLSX, HTML autocontenido).
3. Presupuestos de rendimiento: arranque en frío < 1.5 s, memoria en reposo < 200 MB (sin kernels), F5 en caliente < 300 ms para TS/C#.
4. Firma de código e instaladores (MSI/NSIS, DMG notarizado, AppImage/deb), `updater` con claves de firma, canal estable y beta.
5. Accesibilidad: navegación completa por teclado, roles ARIA en el visor de resultados, contraste AA.
6. i18n (es, en) desde el inicio con claves, no textos incrustados.

---

## 7. Ejemplos que deben funcionar (tests de aceptación de alto nivel)

### 7.1 C#
```csharp
// Expression
DateTime.Now

// Statements
var people = new[] { new { Name = "Ada", Age = 36 }, new { Name = "Linus", Age = 54 } };
people.Where(p => p.Age > 40).Dump("Mayores de 40");

// Con conexión
Customers.Where(c => c.Country == "MX").Take(10).Dump();
```

### 7.2 Java
```java
record Point(int x, int y) {}
var pts = java.util.stream.IntStream.range(0, 5).mapToObj(i -> new Point(i, i * i)).toList();
PolyPad.dump(pts, "Points");
```

### 7.3 Go
```go
type User struct { ID int; Name string }
users := []User{{1, "Ana"}, {2, "Beto"}}
polypad.Dump(users)
```

### 7.4 TypeScript
```ts
const res = await fetch("https://api.github.com/repos/tauri-apps/tauri");
(await res.json()).dump("Repo");
```

### 7.5 SQL
```sql
SELECT status, COUNT(*) AS total FROM orders GROUP BY status ORDER BY total DESC;
```

---

## 8. Estándares de ingeniería (checklist de revisión en cada PR)

**Rust**
- Errores con `thiserror` en librerías, conversiones explícitas en la frontera de comandos a un `CommandError` serializable (sin filtrar rutas internas ni secretos).
- Nada bloqueante en el runtime async (`spawn_blocking` para I/O síncrono pesado).
- Concurrencia: preferir paso de mensajes (`mpsc`) sobre locks; si hay locks, nunca mantenerlos a través de `.await`.
- Estado de Tauri con `State<'_, T>` y tipos `Send + Sync` bien definidos; sin singletons globales mutables.
- Tests unitarios por módulo, tests de integración del protocolo con kernels falsos, property tests (`proptest`) para el parser `.ppad` y el framing.

**Frontend**
- Componentes pequeños, lógica en hooks; sin llamadas a `invoke` fuera de `shared/ipc`.
- Todo HTML proveniente de resultados pasa por DOMPurify; jamás `dangerouslySetInnerHTML` sin sanitizar.
- Listas y tablas grandes siempre virtualizadas; memoización medida con el profiler, no por intuición.

**Seguridad**
- Capabilities mínimas por ventana; revisar cada permiso nuevo en el PR.
- CSP sin `unsafe-eval` en la ventana principal (si Monaco lo exige para algo, aislarlo y documentarlo en un ADR).
- Código del usuario sólo en kernels; los kernels no heredan variables de entorno sensibles; directorio de trabajo temporal por sesión.
- `cargo deny` con licencias permitidas y bans de crates duplicados/no mantenidos.

**Documentación**
- Un ADR por decisión relevante (protocolo, elección de motor por lenguaje, estrategia de sandbox, LSP broker).
- `CONTRIBUTING.md` con cómo añadir un nuevo kernel en ≤ 10 pasos.

---

## 9. Definición de terminado (global)

- Los ejemplos de §7 funcionan en Windows, macOS y Linux.
- Suite de conformidad de kernels en verde para todos los lenguajes soportados.
- Presupuestos de rendimiento de la Fase 8 cumplidos y medidos en CI (benchmarks con `criterion` para el core y pruebas E2E con `tauri-driver`/WebDriver).
- Cero warnings, cero `unwrap` en producción, auditorías de dependencias limpias.
- Revisión final documentada: riesgos conocidos, deuda técnica explícita y siguientes pasos.

Empieza por la **Fase 0**. Antes de escribir código, presenta un plan breve de la fase, las APIs que vas a consultar en Context7 y los riesgos que ves.
