# ADR-0008: Code editor — plain Monaco behind an adapter, and what it costs the CSP

- **Status:** Accepted
- **Date:** 2026-09-30
- **Amends:** ADR-0003 (Content Security Policy)

## Context

Phase 1 needs a code editor for ten languages, and Phase 6 will add LSP-based IntelliSense
through a Rust broker. Two stacks were considered (research of 2026-09-30):

- **Plain `monaco-editor` 0.57** — about 5 MB, stable API, Monarch grammars. Since 0.55 it ships
  its own LSP client (`monaco.lsp.MonacoLspClient`) with a pluggable transport.
- **`@codingame/monaco-vscode-api` + `monaco-languageclient` 11** — VS Code's services and
  TextMate grammars, a direct path to LSP, but about 15 MB, roughly 60 packages that must share
  one version (a new major almost weekly), and CSP additions (`'wasm-unsafe-eval'`,
  `connect-src 'self'`).

The security baseline (ADR-0003) forbids `'unsafe-eval'`, sets `style-src 'self'` and freezes
`Object.prototype`. Both stacks needed checking against it in the real WebView.

## Decision

**Plain `monaco-editor`, pinned exactly (0.57.0), behind one adapter module**
(`ui/src/features/editor/monaco/`), the only code allowed to import it (enforced by ESLint).
Only the editor core, its features, one worker and the Monarch grammars of the ten languages are
bundled; the TypeScript and JSON language services are left out (they would flag `dump()` and
clash with Phase 6). The editor chunk is loaded lazily so the shell paints first. Phase 6 starts
with a spike choosing between Monaco's native LSP client and migrating the adapter to the
`@codingame` stack.

**CSP changes, verified in WebView2 through the remote debugging protocol:**

- `style-src 'self' 'unsafe-inline'`. Monaco creates `<style>` elements and inline `style`
  attributes at runtime and has no nonce support (monaco-editor issue #271); with `'self'` alone
  the editor rendered without layout (zero-height lines) and the console filled with
  `style-src-elem` and `style-src-attr` violations. The risk is limited to style injection;
  `script-src` stays `'self'`, without `'unsafe-eval'`.
- `dangerousDisableAssetCspModification: ["style-src"]`. Tauri adds hashes or nonces for inline
  styles it finds in the HTML, and any hash or nonce makes browsers ignore `'unsafe-inline'`. None
  is added today (`index.html` has no `<style>`), but this keeps a future one from silently
  breaking the editor.
- `worker-src 'self'` (was `'self' blob:`). The editor worker is bundled as a file and served
  from the app origin; nothing creates `blob:` workers.

**`freezePrototype` stays on.** Monaco's compiled TypeScript namespaces assign their own
`toString` (`KeyCodeUtils.toString = toString`), which throws once `Object.prototype` is frozen:
JavaScript refuses to shadow a read-only inherited property by assignment. A Vite plugin
(`ui/build/frozenPrototypeCompat.ts`) rewrites exactly those statements into
`Object.defineProperty` calls with the same effect, both in production builds and in the dev
server's dependency pre-bundling. The build fails if the set of rewritten statements differs from
the expected list (four in 0.57.0), so a Monaco upgrade cannot silently reintroduce the crash.

## Alternatives

- **Turning `freezePrototype` off** (Tauri's default, and what VS Code runs with) was rejected by
  the user: ADR-0003 keeps it as defence in depth against prototype pollution, and the conflict is
  solved in the library integration as that ADR prescribes.
- **Excluding Monaco from dependency pre-bundling** would also let the plugin run in development,
  but makes the dev server load hundreds of modules on every start.
- **`@monaco-editor/react`** loads Monaco from a CDN by default; a small wrapper of our own avoids
  guarding against that.

## Consequences

- A statement the rewrite does not recognise (for example a computed `obj[key] = …` assignment of
  a prototype member) would still fail at runtime; none exists in 0.57.0, and upgrades are checked
  in the WebView before merging.
- Monaco's theme colours are literal hex values mirroring the design tokens; changing a token
  means changing the theme too.
- The editor chunk is about 3.9 MB minified (1 MB gzip), loaded after the shell; the cold-start
  budget of Phase 8 is measured with it.
