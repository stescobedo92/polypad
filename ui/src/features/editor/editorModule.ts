import type { BufferId } from "../../shared/ipc";
import type { TextBuffers } from "../workspace/textBuffers";

/** Cursor position shown in the status bar (one-based). */
export interface CursorPosition {
  readonly line: number;
  readonly column: number;
}

/** The editor the UI drives: it shows one buffer at a time. */
export interface EditorHandle {
  /** Shows buffer `id`, restoring its cursor and scroll; `null` shows nothing. */
  show(id: BufferId | null): void;
  focus(): void;
  onCursorChange(listener: (position: CursorPosition) => void): () => void;
  dispose(): void;
}

/**
 * What the UI needs from an editor implementation. Monaco provides it in the app
 * (docs/adr/0008); tests use a textarea.
 */
export interface EditorModule {
  /** Where the text of open scripts lives. */
  createBuffers(): TextBuffers;
  /** Creates the editor in `container`, showing buffers created by {@link createBuffers}. */
  mount(container: HTMLElement, buffers: TextBuffers): EditorHandle;
  setDarkTheme(dark: boolean): void;
}

/** Loads the editor lazily, so the shell paints before the editor chunk arrives. */
export async function loadEditorModule(): Promise<EditorModule> {
  const { editorModule } = await import("./monaco/monaco");
  return editorModule;
}
