/**
 * Everything the window needs once it is running: the workspace, the explorer, the editor and
 * the subscriptions that keep them in step with the disk and with the backend.
 */
import type { EditorModule } from "../features/editor/editorModule";
import { createExplorer, type Explorer, type ExplorerIpc } from "../features/explorer/explorer";
import type { TextBuffers } from "../features/workspace/textBuffers";
import {
  createWorkspace,
  type Workspace,
  type WorkspaceIpc,
} from "../features/workspace/workspace";
import type { ScriptChanges, ScriptPath, UiPreferences, WorkspaceSnapshot } from "../shared/ipc";
import { DEFAULT_LANGUAGE } from "../shared/languages";

/** The commands and events a session uses; `shared/ipc` provides them in the app. */
export interface SessionIpc extends WorkspaceIpc, ExplorerIpc {
  workspaceSnapshot(): Promise<WorkspaceSnapshot>;
  updatePreferences(preferences: UiPreferences): Promise<void>;
  readyToClose(): Promise<void>;
  onScriptsChanged(handler: (changes: ScriptChanges) => void): Promise<() => void>;
  onFlushRequested(handler: () => void): Promise<() => void>;
}

export interface AppSession {
  readonly workspace: Workspace;
  readonly explorer: Explorer;
  readonly editor: EditorModule;
  readonly buffers: TextBuffers;
  /** The UI preferences as last changed. */
  readonly preferences: () => UiPreferences;
  /** What start-up has to tell the user. */
  readonly notices: {
    /** Tabs of the previous session whose file is gone. */
    readonly skipped: readonly ScriptPath[];
    /** `false` when unsaved work is not journaled, so a crash would lose it. */
    readonly recoveryAvailable: boolean;
  };
  /** Changes the UI preferences; they are saved shortly after the last change. */
  updatePreferences(change: (preferences: UiPreferences) => UiPreferences): void;
  /** Stops reacting to the backend and the window. */
  dispose(): void;
}

export interface SessionDeps {
  readonly ipc: SessionIpc;
  readonly loadEditor: () => Promise<EditorModule>;
}

/** Pause after the last preference change (a panel being dragged) before saving. */
const PREFERENCES_DEBOUNCE_MS = 400;

const EVERYTHING: ScriptChanges = { paths: [], renamed: [], rescan: true };

function warn(context: string) {
  return (error: unknown) => {
    console.warn(context, error);
  };
}

export async function startSession(deps: SessionDeps): Promise<AppSession> {
  const { ipc } = deps;
  // The editor chunk and the first IPC round trip load side by side.
  const [editor, snapshot] = await Promise.all([deps.loadEditor(), ipc.workspaceSnapshot()]);

  const buffers = editor.createBuffers();
  const workspace = createWorkspace({ ipc, buffers });
  const explorer = createExplorer({ ipc, workspace });
  explorer.load(snapshot.scriptsFolder, snapshot.unavailableFolder);
  const { skipped } = await workspace.restore(snapshot.session);
  if (workspace.store.getState().tabs.length === 0) {
    workspace.newScript(snapshot.preferences.lastLanguage ?? DEFAULT_LANGUAGE);
  }

  let disposed = false;
  let preferences = snapshot.preferences;
  let preferencesTimer: ReturnType<typeof setTimeout> | undefined;

  const savePreferences = () => {
    preferencesTimer = undefined;
    ipc.updatePreferences(preferences).catch(warn("cannot save the preferences"));
  };

  /** Events are hints (docs/adr/0007): list the folder again and re-check the open tabs. */
  const reconcile = (changes: ScriptChanges) => {
    if (disposed) return;
    if (explorer.store.getState().tree !== null) {
      explorer.reload().catch(warn("cannot list the scripts folder"));
    }
    workspace.reconcile(changes).catch(warn("cannot check the open scripts"));
  };
  // Changes made while the window was in the background may have been missed.
  const onFocus = () => {
    reconcile(EVERYTHING);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") reconcile(EVERYTHING);
  };
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);

  // jsdom has no matchMedia; a WebView always does.
  const darkScheme =
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)")
      : null;
  const applyTheme = () => {
    editor.setDarkTheme(darkScheme?.matches ?? false);
  };
  applyTheme();
  darkScheme?.addEventListener("change", applyTheme);

  const stopListening = await Promise.all([
    ipc.onScriptsChanged(reconcile),
    ipc.onFlushRequested(() => {
      workspace
        .flushJournal()
        .catch(warn("cannot flush the recovery journal"))
        .finally(() => {
          ipc.readyToClose().catch(warn("cannot confirm the close"));
        });
    }),
  ]);

  return {
    workspace,
    explorer,
    editor,
    buffers,
    preferences: () => preferences,
    notices: { skipped, recoveryAvailable: snapshot.recoveryAvailable },

    updatePreferences(change) {
      preferences = change(preferences);
      clearTimeout(preferencesTimer);
      preferencesTimer = setTimeout(savePreferences, PREFERENCES_DEBOUNCE_MS);
    },

    dispose() {
      disposed = true;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      darkScheme?.removeEventListener("change", applyTheme);
      stopListening.forEach((stop) => {
        stop();
      });
      if (preferencesTimer !== undefined) {
        clearTimeout(preferencesTimer);
        savePreferences();
      }
    },
  };
}
