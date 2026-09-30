/**
 * The only module that imports `monaco-editor` (docs/adr/0008). Everything else talks to the
 * editor through the types exported here, so the editor can be faked in tests and replaced in
 * Phase 6 without touching the rest of the UI.
 *
 * Only what PolyPad uses is bundled: the editor core, its features, one worker and the Monarch
 * grammars of the ten languages. The TypeScript and JSON language services are left out: they
 * would flag `dump()` as an error and would clash with the LSP integration of Phase 6.
 */
import * as monaco from "monaco-editor/editor";
import "monaco-editor/features/register.all";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/csharp/register";
import "monaco-editor/languages/definitions/fsharp/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/kotlin/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/sql/register";

// A worker bundled by Vite and served from 'self': no CDN, no blob: URL, no data: URL.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => new EditorWorker({ name: label }),
};

export const LIGHT_THEME = "polypad-light";
export const DARK_THEME = "polypad-dark";

// Monaco needs literal hex colours, so the design tokens of styles.css are repeated here.
monaco.editor.defineTheme(LIGHT_THEME, {
  base: "vs",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#fafbfc",
    "editor.foreground": "#1a1f28",
    "editorLineNumber.foreground": "#606976",
    "editorLineNumber.activeForeground": "#1a1f28",
    "editorGutter.background": "#fafbfc",
  },
});

monaco.editor.defineTheme(DARK_THEME, {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1d2129",
    "editor.foreground": "#dde2ea",
    "editorLineNumber.foreground": "#808a9a",
    "editorLineNumber.activeForeground": "#dde2ea",
    "editorGutter.background": "#1d2129",
  },
});

export type CodeEditor = monaco.editor.IStandaloneCodeEditor;

/** Creates an editor in `container` showing `code`. */
export function createCodeEditor(
  container: HTMLElement,
  options: { readonly code: string; readonly language: string; readonly dark: boolean },
): CodeEditor {
  return monaco.editor.create(container, {
    value: options.code,
    language: options.language,
    theme: options.dark ? DARK_THEME : LIGHT_THEME,
    automaticLayout: true,
    fontFamily: '"Victor Mono", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
  });
}
