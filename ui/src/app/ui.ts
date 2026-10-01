/** Transient state of the window: the dialog on screen, a notice, the cursor position. */
import type { ParseKeys } from "i18next";
import { createStore, type StoreApi } from "zustand/vanilla";

import type { CursorPosition } from "../features/editor/editorModule";
import type { BufferId, TreeEntry } from "../shared/ipc";

/** A translatable message: a key of the catalogue and its interpolation values. */
export interface Message {
  readonly key: ParseKeys;
  readonly values?: Readonly<Record<string, string | number>>;
}

/** What a name is being asked for. */
export type NamePurpose = "saveAs" | "newScript" | "newFolder" | "rename";

export type Dialog =
  /** A modified tab is being closed. */
  | { readonly kind: "unsaved"; readonly tabId: BufferId }
  /** A name is needed; `error` explains why the last one was not accepted. */
  | {
      readonly kind: "name";
      readonly purpose: NamePurpose;
      readonly initial: string;
      readonly error?: Message;
    }
  | { readonly kind: "confirmDelete"; readonly entry: TreeEntry };

export interface UiState {
  readonly dialog: Dialog | null;
  /** A message shown until dismissed (a failed action, something start-up has to say). */
  readonly notice: Message | null;
  readonly cursor: CursorPosition;
}

export type Ui = StoreApi<UiState>;

export function createUi(): Ui {
  return createStore<UiState>(() => ({
    dialog: null,
    notice: null,
    cursor: { line: 1, column: 1 },
  }));
}
