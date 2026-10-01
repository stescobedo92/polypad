/**
 * What the user can do, in terms of the workspace, the explorer and the dialogs: components call
 * these and render state, without logic of their own. None of them rejects: a failure is shown
 * as a notice, so they can be handed to event handlers as they are.
 */
import { CommandFailure, type BufferId, type ScriptPath, type TreeEntry } from "../shared/ipc";
import { DEFAULT_LANGUAGE } from "../shared/languages";
import { fileNameOf, scriptTitle } from "../shared/scripts";
import type { AppSession } from "./session";
import type { Message, NamePurpose, Ui } from "./ui";

export interface Actions {
  /** Opens an untitled script in the language of the active tab. */
  readonly newScript: () => void;
  readonly openScript: (path: ScriptPath) => Promise<void>;
  /** Saves a tab; an untitled one asks for a name first. */
  readonly save: (id: BufferId) => Promise<void>;
  /** Closes a tab, asking first when it has unsaved changes. */
  readonly closeTab: (id: BufferId) => Promise<void>;
  /** Replaces a tab with the file on disk, discarding its unsaved changes. */
  readonly reloadFromDisk: (id: BufferId) => Promise<void>;
  /** Answers the unsaved-changes dialog. */
  readonly resolveUnsaved: (choice: "save" | "discard" | "cancel") => Promise<void>;
  /**
   * Answers the name dialog; it stays open with the reason when the name is refused. `folder`
   * is where "save as" puts the script (the top level by default).
   */
  readonly submitName: (name: string, folder?: ScriptPath | null) => Promise<void>;
  readonly cancelDialog: () => void;
  readonly promptNewScript: (parent: ScriptPath | null) => void;
  readonly promptNewFolder: (parent: ScriptPath | null) => void;
  readonly promptRename: (entry: TreeEntry) => void;
  readonly promptDelete: (entry: TreeEntry) => void;
  /** Answers the delete confirmation. */
  readonly confirmDelete: () => Promise<void>;
  readonly move: (path: ScriptPath, folder: ScriptPath | null) => Promise<void>;
  readonly chooseScriptsFolder: (title: string) => Promise<void>;
  readonly dismissNotice: () => void;
}

/** What the name dialog is for, with what it needs to finish the job. */
type PendingName =
  | { readonly purpose: "saveAs"; readonly tabId: BufferId; readonly thenClose: boolean }
  | { readonly purpose: "newScript"; readonly parent: ScriptPath | null }
  | { readonly purpose: "newFolder"; readonly parent: ScriptPath | null }
  | { readonly purpose: "rename"; readonly entry: TreeEntry };

/** The message to show for a failed action. */
export function failureMessage(error: unknown): Message {
  if (!(error instanceof CommandFailure)) {
    console.error(error);
    return { key: "errors.internal", values: { reference: "ui" } };
  }
  const failure = error.error;
  switch (failure.code) {
    case "internal":
      return { key: "errors.internal", values: { reference: failure.reference } };
    case "invalidName":
      return failure.problem.kind === "invalidCharacter"
        ? {
            key: "errors.invalidName.invalidCharacter",
            values: { character: failure.problem.character },
          }
        : { key: `errors.invalidName.${failure.problem.kind}` };
    case "unsupportedDocument": {
      const problem = failure.problem;
      switch (problem.kind) {
        case "invalidHeader":
          return {
            key: "errors.unsupportedDocument.invalidHeader",
            values: { line: problem.line, column: problem.column },
          };
        case "missingSeparator":
          return {
            key: "errors.unsupportedDocument.missingSeparator",
            values: { line: problem.line },
          };
        case "invalidField":
          return {
            key: "errors.unsupportedDocument.invalidField",
            values: { field: problem.field },
          };
        default:
          return { key: `errors.unsupportedDocument.${problem.kind}` };
      }
    }
    default:
      return { key: `errors.${failure.code}` };
  }
}

export function createActions(session: AppSession, ui: Ui): Actions {
  const { workspace, explorer } = session;
  let pendingName: PendingName | null = null;

  const tab = (id: BufferId) => workspace.store.getState().tabs.find((t) => t.id === id);

  function notify(error: unknown): void {
    ui.setState({ notice: failureMessage(error) });
  }

  /** Runs an action started from the UI: a failure becomes a notice, never a lost rejection. */
  async function attempt(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      notify(error);
    }
  }

  function askName(pending: PendingName, initial: string): void {
    pendingName = pending;
    const purpose: NamePurpose = pending.purpose;
    ui.setState({ dialog: { kind: "name", purpose, initial } });
  }

  function closeDialog(): void {
    pendingName = null;
    ui.setState({ dialog: null });
  }

  function askSaveName(id: BufferId, thenClose: boolean): void {
    const previous = tab(id)?.previousPath;
    const suggestion = previous == null ? "" : scriptTitle(fileNameOf(previous));
    askName({ purpose: "saveAs", tabId: id, thenClose }, suggestion);
  }

  /** Saves; `true` once the tab is on disk. A conflict shows in the tab, not here. */
  async function save(id: BufferId, thenClose: boolean): Promise<boolean> {
    try {
      // Nothing on disk to lose: saving a deleted script just creates it again.
      if (tab(id)?.disk === "missing") {
        workspace.keepMine(id);
      }
      const outcome = await workspace.save(id);
      if (outcome === "needs-name") {
        askSaveName(id, thenClose);
      }
      return outcome === "saved";
    } catch (error) {
      notify(error);
      return false;
    }
  }

  async function runPendingName(
    pending: PendingName,
    name: string,
    folder: ScriptPath | null,
  ): Promise<void> {
    switch (pending.purpose) {
      case "saveAs": {
        await workspace.saveAs(pending.tabId, folder, name);
        await explorer.reload();
        if (pending.thenClose) {
          await workspace.requestClose(pending.tabId);
        }
        return;
      }
      case "newScript": {
        const active = tab(workspace.store.getState().activeId ?? "");
        await explorer.newScript(
          pending.parent,
          name,
          active?.header.language ?? session.preferences().lastLanguage ?? DEFAULT_LANGUAGE,
        );
        return;
      }
      case "newFolder":
        await explorer.newFolder(pending.parent, name);
        return;
      case "rename":
        await explorer.rename(pending.entry, name);
    }
  }

  return {
    newScript() {
      const active = tab(workspace.store.getState().activeId ?? "");
      const language =
        active?.header.language ?? session.preferences().lastLanguage ?? DEFAULT_LANGUAGE;
      workspace.newScript(language);
      session.updatePreferences((preferences) => ({ ...preferences, lastLanguage: language }));
    },

    openScript: (path) => attempt(() => workspace.openScript(path)),

    reloadFromDisk: (id) => attempt(() => workspace.reloadFromDisk(id)),

    async save(id) {
      await save(id, false);
    },

    closeTab: (id) =>
      attempt(async () => {
        if ((await workspace.requestClose(id)) === "unsaved") {
          ui.setState({ dialog: { kind: "unsaved", tabId: id } });
        }
      }),

    resolveUnsaved: (choice) =>
      attempt(async () => {
        const dialog = ui.getState().dialog;
        if (dialog?.kind !== "unsaved") return;
        const id = dialog.tabId;
        closeDialog();
        if (choice === "discard") {
          await workspace.discardAndClose(id);
        } else if (choice === "save" && (await save(id, true))) {
          await workspace.requestClose(id);
        }
      }),

    async submitName(name, folder = null) {
      const pending = pendingName;
      const dialog = ui.getState().dialog;
      if (pending === null || dialog?.kind !== "name") return;
      try {
        await runPendingName(pending, name, folder);
        closeDialog();
      } catch (error) {
        ui.setState({ dialog: { ...dialog, initial: name, error: failureMessage(error) } });
      }
    },

    cancelDialog: closeDialog,

    promptNewScript(parent) {
      askName({ purpose: "newScript", parent }, "");
    },

    promptNewFolder(parent) {
      askName({ purpose: "newFolder", parent }, "");
    },

    promptRename(entry) {
      askName(
        { purpose: "rename", entry },
        entry.kind === "script" ? scriptTitle(entry.name) : entry.name,
      );
    },

    promptDelete(entry) {
      ui.setState({ dialog: { kind: "confirmDelete", entry } });
    },

    confirmDelete: () =>
      attempt(async () => {
        const dialog = ui.getState().dialog;
        if (dialog?.kind !== "confirmDelete") return;
        closeDialog();
        await explorer.remove(dialog.entry.path);
      }),

    move: (path, folder) =>
      attempt(async () => {
        await explorer.move(path, folder);
      }),

    chooseScriptsFolder: (title) =>
      attempt(async () => {
        if ((await explorer.chooseFolder(title)) === "unsaved") {
          ui.setState({ notice: { key: "errors.unsavedBeforeSwitch" } });
        }
      }),

    dismissNotice() {
      ui.setState({ notice: null });
    },
  };
}
