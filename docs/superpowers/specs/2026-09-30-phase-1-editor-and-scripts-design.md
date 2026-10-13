# Phase 1 — UI shell, editor and scripts: design

- **Status:** Approved in conversation, pending review of this document
- **Date:** 2026-09-30
- **Source:** `docs/spec/polypad-spec.md` §6 "Fase 1", §3.1, §3.5, §8

## 1. Goal and acceptance

Turn the Phase 0 layout into a working script editor: Monaco editing `.ppad` documents in tabs,
a "My Scripts" tree backed by a folder on disk, resizable persisted panels, a command palette and
the keyboard shortcuts of spec §3.5. Code execution stays out of scope (kernels arrive in Phase 2).

Acceptance (spec §6, Fase 1):

1. Create, rename, move, save and reopen scripts.
2. Changes made on disk by other programs are reflected in the app.
3. No data loss when the app is killed: at most the last second of typing (see §5.4).

## 2. Decisions taken with the user

| Topic | Decision |
|---|---|
| Save model | **Explicit save + recovery journal** ("hot exit"). Ctrl+S writes the `.ppad`; unsaved buffers are journaled continuously and restored on the next start without prompting. |
| Editor | **Plain `monaco-editor` 0.57** behind a single adapter module. Phase 6 runs a spike to choose between Monaco's native LSP client and migrating to the `@codingame/monaco-vscode-api` stack. |
| Delivery | **Three sequential PRs** (1a core, 1b UI, 1c commands); the phase closes with 1c and the acceptance checklist. |

## 3. Non-goals

- Running code, Run/Stop behaviour (Phase 2). F5 and Shift+F5 are registered but disabled.
- LSP, IntelliSense and Monaco's built-in TypeScript language service (Phase 6).
- Opening `.ppad` files outside the scripts folder; multiple scripts folders.
- A UI for editing key bindings (Phase 8); overrides are possible through the preferences file.
- Samples content (Phase 8); the Samples section stays inert.
- A user override of the light/dark theme; the app follows the operating system.

## 4. Architecture

```
UI (React)                                     Rust
───────────────────────────────                ─────────────────────────────────────────────
editor/monaco  (only importer of monaco)       src-tauri: thin commands + typed events
stores (Zustand): documents · workspace · ui  ⇄ IPC ⇄   │ spawn_blocking
commands: registry · keybindings · palette     │
explorer tree · script tabs · panels           polypad-core (no Tauri dependency)
                                                  ├─ ppad         .ppad format, migrations
                                                  ├─ scripts      ScriptStore, ScriptWatcher
                                                  ├─ recovery     journal of unsaved buffers
                                                  ├─ preferences  preferences file
                                                  └─ atomic_fs    atomic writes with retries
```

### 4.1 Rust modules (`polypad-core`)

Each module has one purpose and is tested without a WebView.

- **`ppad`**: `Document { header, code }`, `parse(&str) -> Result<Document, PpadError>`,
  `serialize(&Document) -> String`, version migrations (§5.1).
- **`scripts`**: `ScriptPath` (validated relative path), `ScriptStore` (tree listing and file
  operations confined to the scripts root), `ScriptWatcher` (debounced recursive watcher), content
  stamps (§5.2, §5.3).
- **`recovery`**: `RecoveryJournal` (session file plus one file per unsaved buffer) (§5.4).
- **`preferences`**: `Preferences` load/save with unknown fields preserved (§5.5).
- **`atomic_fs`**: write-to-temp, fsync, rename; retries on Windows sharing violations.

`Language` and `ExecutionMode` become Rust enums exported through tauri-specta, so the ids are
defined once. `ui/src/shared/languages.ts` keeps presentation metadata (label, modes order, line
comment) keyed by the generated types, with a compile-time exhaustiveness check.

### 4.2 IPC surface (`src-tauri`)

Commands stay thin adapters (docs/adr/0002). File work runs in `spawn_blocking`; shared state
lives in `State<'_, AppState>` and no lock is held across an `.await`.

| Command | Purpose |
|---|---|
| `workspace_snapshot` | Preferences, scripts tree and recovered session in one call at start-up. |
| `list_scripts` | Current tree (after `ScriptsChanged` or on focus). |
| `open_script` | Parsed document plus its content stamp. |
| `script_status` | Current stamp of a path, or `missing`. |
| `save_script` | Write a document if the disk still matches the expected stamp. |
| `create_script`, `create_folder` | Create entries inside the scripts root. |
| `rename_entry`, `move_entry` | Rename or move a script or folder. |
| `delete_entry` | Move a script or folder to the operating system's trash. |
| `journal_buffer`, `discard_buffer`, `set_session` | Recovery journal updates. |
| `ready_to_close` | The UI finished flushing the journal; the window may close. |
| `choose_scripts_folder` | Native folder picker (opened from Rust) and root switch. |
| `update_preferences` | Persist the UI preferences (panel sizes, key bindings, last language). |

Events: `ScriptsChanged { paths, rescan }` and `FlushRequested`.

`CommandError` gains typed variants the UI can act on — `Conflict`, `NotFound`, `AlreadyExists`,
`InvalidName`, `UnsupportedDocument { reason }` — alongside `Internal`. Payloads carry only data the
UI sent (relative script paths) or fixed reason codes; never absolute paths or file contents.

Plugins: `tauri-plugin-window-state` and `tauri-plugin-dialog`, both used **only from Rust**. The
main-window capability gains the `allow-<command>` permissions of the commands above plus
`core:event:allow-listen` / `core:event:allow-unlisten`, which the typed event listeners need.

### 4.3 UI

- **Stores (Zustand):** `documents` (open buffers: id, path, header, dirty flag, stamp, conflict
  state — the text lives in Monaco models), `workspace` (tree, scripts root), `ui` (palette, panel
  collapse state). TanStack Query is deferred to Phase 4, where remote async data appears.
  *As built in PR 1b:* the documents store is `features/workspace/workspace.ts`, the tree is
  `features/explorer/explorer.ts` and `app/ui.ts` holds the dialog, notice and cursor; `app/session.ts`
  wires them to the backend and `app/actions.ts` is the only thing components call. None of them
  imports React, so they are tested against an in-memory backend.
- **Editor adapter** (`features/editor/monaco/`): the only module that imports `monaco-editor`,
  loaded lazily so the shell paints before the ~4 MB editor chunk (§6.2).
- **Command registry** (`shared/commands/`): single source for menus, palette and shortcuts (§6.4).

## 5. Behaviour

### 5.1 `.ppad` format

```
{
  "ppad": 1,
  "language": "csharp",
  "mode": "statements",
  "connection": null,
  "packages": [{ "name": "Dapper", "version": "2.1.35" }],
  "imports": ["System.Text.Json"]
}
---
var top = Orders.Take(20);
top.Dump("Top orders");
```

- **Layout:** one JSON object (the header), a newline, a line containing exactly `---`, a newline,
  then the code verbatim to the end of the file.
- **Parsing:** read exactly one JSON value with `serde_json`'s streaming deserializer (a `---`
  inside a header string cannot confuse it), then require the separator line; everything after it
  is code, byte for byte.
- **Header fields:** `ppad` (format version, integer, also the magic value), `language`, `mode`,
  `connection` (connection id or `null`; used from Phase 4), `packages` (`[{ name, version }]`;
  used from Phase 7), `imports` (`[string]`). Unknown fields are preserved (`#[serde(flatten)]`)
  and written back unchanged.
- **Writing:** keys in the order above, then unknown fields; two-space indentation; UTF-8 without
  BOM; the header uses the newline style detected when the file was read (LF for new files), so a
  parse/serialize round trip is byte-exact.
- **Reading:** a leading UTF-8 BOM is accepted and dropped.
- **Versioning:** an older `ppad` version is migrated in memory through a chain of pure functions
  on `serde_json::Value` (v1→v2→…) and only rewritten when the user saves. A **newer** version is
  rejected (`UnsupportedDocument { reason: "newer-format" }`) so a file is never overwritten with
  data this build does not understand.
- **Validation:** `language` and `mode` must be known values. A known mode that the language does
  not offer opens with the language's default mode and marks the document dirty.
- **Errors** (`PpadError`, with line and column where applicable): missing header, invalid JSON,
  missing separator, newer format, unknown language, unknown mode, file larger than 16 MiB.

### 5.2 Scripts folder and tree

- **Root:** `preferences.scriptsRoot`; default `document_dir()/PolyPad`, falling back to
  `home_dir()/PolyPad` when the platform has no documents folder. Only the default folder is
  created; a configured folder that is missing is reported (`unavailableFolder` in the start-up
  snapshot) and the default one is used for the session.
- **Changing the root:** *File → Choose scripts folder…* opens the native picker from Rust. The
  switch is refused while tabs of the current root have unsaved changes; clean tabs of the old root
  are closed, untitled buffers are unaffected. The watcher restarts on the new root.
- **`ScriptPath`:** relative, `/`-separated, normalized; every component is non-empty, at most 255
  bytes, not `.`/`..`, free of characters invalid on any supported OS (`<>:"/\|?*` and control
  characters), not a reserved Windows device name (`CON`, `NUL`, `COM1`…) and without a trailing dot
  or space. Script files end in `.ppad`.
- **Confinement:** every operation resolves `root.join(path)`, canonicalizes it and rejects results
  outside the canonical root, which also defeats symlink escapes. The WebView never sends or
  receives absolute paths; the root is only chosen through the native picker.
- **Listing:** folders and `*.ppad` files only; hidden entries (leading `.`) are skipped; folders
  first, then case-insensitive natural order. The walk stops at 10,000 entries and reports
  `truncated: true`.
- **Operations:** create script (from a header and empty code), create folder, rename, move (tree
  drag and drop), delete. Delete asks for confirmation and moves the entry to the operating system's
  trash (`trash` crate); nothing is deleted permanently. Name collisions return `AlreadyExists`.

### 5.3 Watching external changes

- `notify` 8.2 with `notify-debouncer-full` 0.7, recursive on the root, 250 ms debounce. The
  debouncer thread forwards batches through a `tokio::sync::mpsc` channel to a task that emits
  `ScriptsChanged`.
- Events are **hints**: the UI reloads the tree through `list_scripts`. The app also reconciles
  after a reported watcher error (and restarts the watcher), on `Rescan`, whenever the window
  regains focus, and every 30 seconds: notify 8.2's Windows backend reports neither its errors nor
  buffer overflows, so the periodic rescan bounds how long a lost change goes unnoticed.
- **Own writes are ignored:** the store keeps the last known stamp per path (BLAKE3 hash of the
  file bytes); a change whose current stamp equals the known one is not external.
- **Open tabs** affected by a change ask `script_status`:
  - stamp unchanged → nothing;
  - changed, buffer clean → reload silently, keeping the cursor where possible;
  - changed, buffer dirty → conflict banner in the editor: **Reload** (discard my changes) or
    **Keep mine** (adopt the disk stamp as the new baseline, so the next save overwrites);
  - missing → the tab shows "deleted on disk" and keeps its text; saving recreates the file;
  - a paired rename event updates the tab's path.

### 5.4 Saving and recovery

- **Save (Ctrl+S):** the UI sends path, header, code and the stamp it opened or last saved. Rust
  compares it with the disk; a mismatch returns `Conflict` (the banner appears) instead of
  overwriting. Otherwise it serializes and writes atomically (temporary file in the same folder,
  fsync, rename; up to 5 retries with backoff on Windows sharing violations) and returns the new
  stamp. The buffer becomes clean and its journal entry is removed.
- **Untitled buffers:** *Save* opens an in-app dialog to pick a name and a folder inside the scripts
  root, then calls `create_script`.
- **Closing a dirty tab:** Save / Don't save / Cancel.
- **Journal location:** `app_local_data_dir()/recovery/` (machine-local, not roamed):
  - `session.json`: ordered tabs `[{ bufferId, path | null }]` and the active tab; written on every
    tab change.
  - `buffers/<bufferId>.json`: `{ path | null, baseStamp | null, header, code, updatedAt }`, one per
    dirty buffer. Written by `journal_buffer` with a 300 ms debounce and a 1 s maximum wait while
    typing; removed when the buffer becomes clean or its tab is closed.
  - All journal files are written with `atomic_fs`.
- **Normal close:** Rust intercepts `CloseRequested`, emits `FlushRequested`, and closes when the UI
  calls `ready_to_close` or after 1 s, whichever comes first. No "unsaved changes" prompt.
- **Folder identity:** the journal records which scripts folder each tab and snapshot belongs
  to. Work from a folder that is not open at start-up comes back detached (untitled, with
  `previousPath` as a hint); clean tabs of that folder are dropped.
- **Start-up:** every session tab comes back. A tab with a journal entry is restored dirty with its
  journaled text; if the disk stamp no longer matches `baseStamp`, the conflict banner appears. A
  buffer file not listed in the session (a crash between writes) is restored as an extra tab, never
  dropped silently. A tab whose file vanished and has no journal entry is skipped with a notice.
- **Guarantee:** killing the process loses at most the last second of typing.

### 5.5 Preferences

`app_config_dir()/preferences.json`, written atomically, unknown fields preserved:

```json
{
  "version": 1,
  "scriptsRoot": "C:\\Users\\me\\Documents\\PolyPad",
  "layout": {
    "workspace": { "explorer": 18, "main": 82 },
    "document": { "editor": 60, "results": 40 }
  },
  "keybindings": { "workbench.togglePalette": "Ctrl+Shift+P" },
  "lastLanguage": "csharp"
}
```

An unreadable or invalid file is kept aside as `preferences.invalid-<timestamp>.json`, defaults are
used and a warning is logged; start-up never fails because of preferences. A value this build
cannot decode (such as a language added later) is dropped on its own, and a file written by a newer
version keeps its version number when saved.

Only `UiPreferences` (`layout`, `keybindings`, `lastLanguage`) crosses the IPC boundary;
`scriptsRoot` is an absolute path and stays in Rust (§5.2). Collapsed panels need no field of their
own: the layout stores them at their collapsed size.

## 6. User interface

### 6.1 Layout

- `react-resizable-panels` 4.x (`Group` / `Panel` / `Separator`): horizontal `explorer | main`,
  vertical `editor | results`. Explorer and results are collapsible.
- Sizes come from `workspace_snapshot` as `defaultLayout` (a `{ panelId: percent }` map per
  group, keyed by group id as in §5.5); `onLayoutChanged` with `isUserInteraction` saves them
  through a debounced `update_preferences`. A collapsed panel is stored as its collapsed size.
- `tauri-plugin-window-state` persists size, position and maximized state (not visibility). The
  window starts hidden and is shown after restoration to avoid a flash.

### 6.2 Editor

- `monaco-editor` 0.57, imported only by the adapter, loaded with a dynamic `import()`.
- Monarch grammars for the ten languages (`languages/definitions/<lang>/register`); no TypeScript
  or JSON language services (they would flag `dump()` and clash with Phase 6 LSP).
- One worker (`editor.worker`) through Vite's `?worker` import and `MonacoEnvironment.getWorker`;
  `worker: { format: "es" }` in the Vite config.
- One model per buffer (`ppad:///<bufferId>`); each tab keeps its view state (cursor, scroll,
  folding).
- Themes `polypad-light` and `polypad-dark` built from the design tokens (hex values), switched with
  `matchMedia("(prefers-color-scheme: dark)")`. Victor Mono is already bundled.
- The Language and Mode pickers edit the document header (and mark it dirty); the status bar shows
  the live cursor position and the line-ending style.

### 6.3 Explorer and tabs

- "My Scripts" is an accessible tree (`role="tree"`): arrow keys, Enter opens, F2 renames, Delete
  deletes; context menu with New script, New folder, Rename, Delete; drag and drop to move.
  HTML drag and drop needs `dragDropEnabled: false` on the main window: otherwise Tauri takes every
  drop for its native file-drop event, which on Windows stops the page from seeing it. PolyPad does
  not use that event.
- Tabs show a dirty dot, "deleted on disk" and conflict states; Ctrl+W closes the active tab.
- Connections and Samples stay as in Phase 0.

### 6.4 Commands, menus, palette and shortcuts

- A registry of commands `{ id, title (i18n key), keybinding, enabled, run }` feeds the menu bar
  (now functional, built on Radix UI menubar primitives), the palette and the shortcuts.
- One `keydown` listener on `window` in the **capture** phase dispatches bindings before Monaco and
  the WebView see them, then calls `preventDefault` and `stopPropagation`.
- Palette: `cmdk` inside a native `<dialog>` (Ctrl+Shift+P). Quick open (Ctrl+P): fuzzy search over
  the scripts tree with `shouldFilter={false}` and our own matcher.
- Default bindings (overridable through `preferences.keybindings`):

| Command | Binding | Phase 1 state |
|---|---|---|
| Run all / selection | F5 · Ctrl+Enter | registered, disabled |
| Cancel | Shift+F5 | registered, disabled |
| New script (same language) | Ctrl+N | works |
| Save | Ctrl+S | works |
| Close tab | Ctrl+W | works |
| Change language | Ctrl+Shift+L | works (overrides Monaco's "select all occurrences", still on Ctrl+F2) |
| Command palette | Ctrl+Shift+P | works |
| Find script | Ctrl+P | works |
| Toggle results panel | Ctrl+R | works |
| Results tab 1–5 | Ctrl+1 … Ctrl+5 | works (tabs stay empty until Phase 2) |

- The browser context menu (Reload, Print…) is suppressed outside the editor; Monaco keeps its own.

## 7. Security

- **CSP:** `style-src 'self' 'unsafe-inline'` in `csp` and `devCsp`. Monaco injects `<style>`
  elements and inline style attributes at runtime and has no nonce support (monaco-editor #271).
  The risk is limited to style injection; `script-src` stays `'self'` without `'unsafe-eval'`.
  If Tauri's asset CSP modification adds a nonce or hash to `style-src` (which makes browsers ignore
  `'unsafe-inline'`), `dangerousDisableAssetCspModification: ["style-src"]` is set. `worker-src`
  drops `blob:` if the bundled worker proves it unnecessary.
- **Paths:** confinement rules in §5.2; the WebView never handles absolute paths.
- **Capabilities:** new `allow-<command>` entries and event listening (not emitting); no dialog or
  window-state permission reaches the WebView.
- **Logging:** paths are logged relative to the root; script contents are never logged.
- **ADRs:** ADR-0006 (`.ppad` format) and ADR-0007 (scripts workspace, saving and recovery,
  amending ADR-0002 and ADR-0003) in PR 1a; ADR-0008 (editor choice, the CSP change and the
  Phase 6 spike) in PR 1b.

## 8. Error handling

- Library errors are `thiserror` enums per module (`PpadError`, `ScriptError`, `RecoveryError`,
  `PreferencesError`); commands map them to `CommandError` variants (§4.2).
- The UI turns typed errors into inline states (conflict banner, name validation message,
  "deleted on disk") and anything `Internal` into a toast with the error reference.
- Watcher failures never surface as errors to the user: they trigger reconciliation and a restart,
  and are logged.
- Journal write failures are logged and shown once as a non-blocking warning ("recovery is not
  available"); editing continues.

## 9. Testing

- **Rust:**
  - `ppad`: unit tests per error; `proptest` round trip (`parse(serialize(doc)) == doc` for
    arbitrary headers and code, including `---` lines, mixed CRLF, Unicode and empty code) and
    "parse never panics" on arbitrary input.
  - `scripts`: `ScriptPath` validation table; store operations on temporary folders; escape
    attempts with `..`, absolute paths and symlinks; conflict detection; trash integration behind
    a trait so tests do not touch the real trash.
  - Watcher: external create, modify, rename and delete are observed (generous timeouts). No
    overflow stress test: on Windows notify reports overflows to nobody, so the periodic rescan,
    not the watcher, is what bounds a lost change.
  - `recovery` and `preferences`: round trips, orphan buffers, corrupt files.
  - Commands: serialization of `CommandError` variants; bindings stay up to date.
- **UI (Vitest + Testing Library):** stores; keybinding dispatcher (including events from a
  textarea, as Monaco uses one); palette filtering; tree keyboard navigation; tab close and dirty
  flows; conflict banner. Monaco is replaced by a fake behind the adapter interface.
- **Manual:** acceptance checklist on the real app (Windows locally), CI on the three platforms.
  End-to-end tests with `tauri-driver` belong to Phase 8 (spec §9).

## 10. Documentation to consult (Context7 first)

`monaco-editor` 0.57 (ESM integration, `MonacoEnvironment`, themes), `react-resizable-panels` 4.14,
`tauri` 2.12 (window events and close handling, CSP and `dangerousDisableAssetCspModification`,
path resolver, typed events in tauri-specta), `tauri-plugin-window-state` 2.5,
`tauri-plugin-dialog` 2.8, `notify` 8.2 and `notify-debouncer-full` 0.7, `atomic-write-file` 0.3,
`trash`, `blake3`, `proptest`, `serde_json` (`StreamDeserializer`), `cmdk` 1.1, `zustand`,
`@radix-ui/react-menubar`.

## 11. Risks and early spikes

| Risk | Mitigation |
|---|---|
| WebView2 handles F5, Ctrl+R, Shift+F5 and Ctrl+P (reload, print) before or despite our handler | Spike in PR 1c first. If capture-phase `preventDefault` is not enough, disable browser accelerator keys through `with_webview` and `ICoreWebView2Settings3`, which needs `unsafe` COM calls in `src-tauri`: a justified lint exception plus an ADR. |
| Tauri's CSP nonce injection neutralizes `'unsafe-inline'`; `freezePrototype` breaks Monaco | Spike at the start of PR 1b in the real WebView; `dangerousDisableAssetCspModification` for `style-src`; document any `freezePrototype` change. |
| notify loses events (Windows overflow) or hits inotify limits | Events are hints; reconciliation on errors, rescans and focus. |
| Documents redirected to OneDrive (locks, cloud-only placeholders) | Save retries with backoff; clear error if the file stays locked. |
| Cold-start budget (Phase 8: < 1.5 s) with a ~4 MB editor chunk | Lazy-load the editor; the shell and tree render first. |
| `cmdk` has had no release for about 18 months | Small surface behind our palette component; replaceable. |

## 12. Delivery

1. **PR 1a — script core (Rust):** this document and the ADRs; `ppad`, `scripts` (store, paths,
   watcher), `recovery`, `preferences`, `atomic_fs`; `Language`/`ExecutionMode` enums; commands,
   events, typed `CommandError`, window-state and dialog plugins, capability updates, regenerated
   bindings. UI changes limited to consuming the generated language types.
2. **PR 1b — editor and workspace UI:** CSP spike and change; panels and persistence; Monaco adapter,
   themes, tabs; explorer tree and file operations; save, conflicts, recovery and close flush.
3. **PR 1c — commands:** WebView2 accelerator-key spike; command registry, functional menus, palette,
   quick open and shortcuts; phase acceptance checklist and self-review.

Each PR ends green on CI (three platforms) with its own self-review; Phase 1 closes after PR 1c.

### Requirements PR 1b inherits from the PR 1a review

- Buffer ids come from `crypto.randomUUID()`.
- Journal calls for one buffer are chained (`journal_buffer` then `discard_buffer` never overtake
  each other), because a write can wait up to 620 ms for a Windows lock.
- Focus reconciliation uses the DOM `focus` / `visibilitychange` events (no extra permission).
- Recovered tabs with `previousPath` are shown as untitled copies of that script and can only be
  saved with Save As; `unavailableFolder` is explained in a banner.
- `DocumentTooLarge` and `TrashUnavailable` (for example on network drives) get their own
  messages.
