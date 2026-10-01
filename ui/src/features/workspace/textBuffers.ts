import type { BufferId, LanguageId } from "../../shared/ipc";

/**
 * Where the text of open scripts lives: Monaco models in the app, plain strings in tests.
 *
 * A buffer remembers the text it was last saved with, so it knows whether it is modified even
 * after an edit is undone back to the saved state.
 */
export interface TextBuffers {
  /** Creates a buffer whose saved state is `saved` and whose current text is `current`. */
  create(id: BufferId, language: LanguageId, saved: string, current?: string): void;
  /** Current text. */
  text(id: BufferId): string;
  /** Replaces the text with `text` and makes it the saved state (a reload from disk). */
  replace(id: BufferId, text: string): void;
  /**
   * Makes `text` the saved state: the text that was written, which is not the current text
   * when the user kept typing while the save was in flight.
   */
  markSaved(id: BufferId, text: string): void;
  /** Whether the current text differs from the saved state. */
  isModified(id: BufferId): boolean;
  /** Changes the syntax highlighting of the buffer. */
  setLanguage(id: BufferId, language: LanguageId): void;
  /** Releases the buffer. */
  dispose(id: BufferId): void;
  /** Calls `listener` after every edit; returns a function that stops listening. */
  onDidChange(listener: (id: BufferId) => void): () => void;
}
