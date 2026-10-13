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

import type { BufferId, LanguageId } from "../../../shared/ipc";
import type { TextBuffers } from "../../workspace/textBuffers";
import type { CursorPosition, EditorHandle, EditorModule } from "../editorModule";
import { changedSpan } from "../textDiff";

// A worker bundled by Vite and served from 'self': no CDN, no blob: URL, no data: URL.
self.MonacoEnvironment = {
  getWorker: (_workerId: string, label: string) => new EditorWorker({ name: label }),
};

const LIGHT_THEME = "polypad-light";
const DARK_THEME = "polypad-dark";

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

/** Switches every editor between the light and the dark theme. */
function setDarkTheme(dark: boolean): void {
  monaco.editor.setTheme(dark ? DARK_THEME : LIGHT_THEME);
}

interface BufferModel {
  readonly model: monaco.editor.ITextModel;
  /** Version the saved state corresponds to; `null` when only its text is known. */
  savedVersion: number | null;
  savedText: string;
}

/**
 * Text buffers backed by Monaco models. A buffer is modified when its model's version differs
 * from the saved one, so undoing back to the saved text leaves it clean.
 */
class MonacoBuffers implements TextBuffers {
  private readonly buffers = new Map<BufferId, BufferModel>();
  private readonly listeners = new Set<(id: BufferId) => void>();

  create(id: BufferId, language: LanguageId, saved: string, current: string = saved): void {
    const model = monaco.editor.createModel(saved, language, monaco.Uri.parse(`ppad:///${id}`));
    const entry: BufferModel = {
      model,
      savedVersion: model.getAlternativeVersionId(),
      savedText: saved,
    };
    this.buffers.set(id, entry);
    if (current !== saved) {
      // An undoable edit: undoing recovered work returns to what is on disk.
      model.pushEditOperations(
        [],
        [{ range: model.getFullModelRange(), text: current }],
        () => null,
      );
    }
    model.onDidChangeContent(() => {
      this.listeners.forEach((listener) => {
        listener(id);
      });
    });
  }

  text(id: BufferId): string {
    return this.entry(id).model.getValue();
  }

  replace(id: BufferId, text: string): void {
    const entry = this.entry(id);
    const { model } = entry;
    // Compared by text while the edit is reported, so listeners do not see the new text as an
    // unsaved edit; by version again once the model has one for it.
    entry.savedVersion = null;
    entry.savedText = text;
    const span = changedSpan(model.getValue(), text);
    if (span !== null) {
      // Only what differs, as an undoable edit: unlike `setValue`, the cursor, scroll and undo
      // history survive a reload, and undo brings back the text it replaced.
      const range = monaco.Range.fromPositions(
        model.getPositionAt(span.start),
        model.getPositionAt(span.end),
      );
      model.pushEditOperations([], [{ range, text: span.text }], () => null);
    }
    entry.savedVersion = model.getAlternativeVersionId();
  }

  markSaved(id: BufferId, text: string): void {
    const entry = this.entry(id);
    const unchangedSinceSave = entry.model.getValue() === text;
    entry.savedVersion = unchangedSinceSave ? entry.model.getAlternativeVersionId() : null;
    entry.savedText = text;
  }

  isModified(id: BufferId): boolean {
    const entry = this.entry(id);
    return entry.savedVersion === null
      ? entry.model.getValue() !== entry.savedText
      : entry.model.getAlternativeVersionId() !== entry.savedVersion;
  }

  setLanguage(id: BufferId, language: LanguageId): void {
    monaco.editor.setModelLanguage(this.entry(id).model, language);
  }

  dispose(id: BufferId): void {
    this.buffers.get(id)?.model.dispose();
    this.buffers.delete(id);
  }

  onDidChange(listener: (id: BufferId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The model of a buffer, for the editor. */
  model(id: BufferId): monaco.editor.ITextModel | undefined {
    return this.buffers.get(id)?.model;
  }

  private entry(id: BufferId): BufferModel {
    const entry = this.buffers.get(id);
    if (entry === undefined) {
      throw new Error(`no buffer ${id}`);
    }
    return entry;
  }
}

/** Creates the editor in `container`, showing buffers of `buffers`. */
function createEditor(container: HTMLElement, buffers: MonacoBuffers): EditorHandle {
  const editor = monaco.editor.create(container, {
    model: null,
    automaticLayout: true,
    fontFamily: '"Victor Mono", ui-monospace, monospace',
    fontSize: 13,
    lineHeight: 20,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderLineHighlight: "line",
  });
  const viewStates = new Map<BufferId, monaco.editor.ICodeEditorViewState | null>();
  const cursorListeners = new Set<(position: CursorPosition) => void>();
  let shown: BufferId | null = null;

  const reportCursor = (position: monaco.IPosition | null) => {
    if (position === null) return;
    cursorListeners.forEach((listener) => {
      listener({ line: position.lineNumber, column: position.column });
    });
  };
  editor.onDidChangeCursorPosition((event) => {
    reportCursor(event.position);
  });

  return {
    show(id) {
      if (id === shown) return;
      if (shown !== null) {
        viewStates.set(shown, editor.saveViewState());
      }
      shown = id;
      editor.setModel(id === null ? null : (buffers.model(id) ?? null));
      const viewState = id === null ? undefined : viewStates.get(id);
      if (viewState != null) {
        editor.restoreViewState(viewState);
      }
      // Another buffer means another cursor, whether or not the editor reports it as a move.
      reportCursor(editor.getPosition());
    },
    focus() {
      editor.focus();
    },
    onCursorChange(listener) {
      cursorListeners.add(listener);
      return () => {
        cursorListeners.delete(listener);
      };
    },
    dispose() {
      editor.dispose();
    },
  };
}

export const editorModule: EditorModule = {
  createBuffers: () => new MonacoBuffers(),
  mount(container, buffers) {
    if (!(buffers instanceof MonacoBuffers)) {
      throw new Error("the editor can only show buffers it created");
    }
    return createEditor(container, buffers);
  },
  setDarkTheme,
};
