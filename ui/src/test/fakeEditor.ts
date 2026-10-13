import type { EditorModule } from "../features/editor/editorModule";
import { MemoryBuffers } from "./memoryBuffers";

export interface FakeEditor extends EditorModule {
  /** The buffers created by the last `createBuffers` call. */
  readonly buffers: () => MemoryBuffers;
  /** Whether the dark theme was requested last. */
  readonly dark: () => boolean | null;
}

/** Accessible name of the textarea the fake editor types into. */
export const FAKE_EDITOR_LABEL = "Editor text";

/**
 * An editor made of a textarea: typing in it edits the shown buffer, so tests drive the UI the
 * way a user would without running Monaco (which needs a real browser).
 */
export function fakeEditor(): FakeEditor {
  let buffers = new MemoryBuffers();
  let dark: boolean | null = null;
  return {
    buffers: () => buffers,
    dark: () => dark,
    createBuffers() {
      buffers = new MemoryBuffers();
      return buffers;
    },
    mount(container) {
      const textarea = document.createElement("textarea");
      textarea.setAttribute("aria-label", FAKE_EDITOR_LABEL);
      container.append(textarea);
      let shown: string | null = null;
      const refresh = () => {
        textarea.value = shown !== null && buffers.has(shown) ? buffers.text(shown) : "";
      };
      textarea.addEventListener("input", () => {
        if (shown !== null) buffers.edit(shown, textarea.value);
      });
      // Text replaced from outside (a reload from disk) shows up like in a real editor.
      const stopListening = buffers.onDidChange((id) => {
        if (id === shown && textarea.value !== buffers.text(id)) refresh();
      });
      return {
        show(id) {
          shown = id;
          refresh();
        },
        focus() {
          textarea.focus();
        },
        onCursorChange: () => () => undefined,
        dispose() {
          stopListening();
          textarea.remove();
        },
      };
    },
    setDarkTheme(value) {
      dark = value;
    },
  };
}
