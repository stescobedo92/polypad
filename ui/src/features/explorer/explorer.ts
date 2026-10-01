/**
 * The "My Scripts" tree and the operations on it. Every change goes through Rust and is followed
 * by a fresh listing; open tabs are kept in step through the workspace.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import type {
  CreatedScript,
  Document,
  LanguageId,
  ScriptPath,
  ScriptsFolder,
  ScriptTree,
  TreeEntry,
} from "../../shared/ipc";
import { movedPath, newHeader, scriptFileName, type Workspace } from "../workspace/workspace";

/** The commands the explorer needs; `shared/ipc` provides them in the app. */
export interface ExplorerIpc {
  listScripts(): Promise<ScriptTree>;
  createScript(parent: ScriptPath | null, name: string, document: Document): Promise<CreatedScript>;
  createFolder(parent: ScriptPath | null, name: string): Promise<ScriptPath>;
  renameEntry(path: ScriptPath, name: string): Promise<ScriptPath>;
  moveEntry(path: ScriptPath, folder: ScriptPath | null): Promise<ScriptPath>;
  deleteEntry(path: ScriptPath): Promise<void>;
  chooseScriptsFolder(title: string): Promise<ScriptsFolder | null>;
}

export interface ExplorerState {
  /** Name of the scripts folder; `null` when none could be opened. */
  readonly folderName: string | null;
  /** Its contents; `null` when no scripts folder is open. */
  readonly tree: ScriptTree | null;
  /** Name of the chosen folder that could not be opened at start-up, to explain the fallback. */
  readonly unavailableFolder: string | null;
  /** Folders shown expanded. */
  readonly expanded: ReadonlySet<ScriptPath>;
}

export interface Explorer {
  readonly store: StoreApi<ExplorerState>;
  /** Shows `folder` (from the start-up snapshot or the folder picker). */
  load(folder: ScriptsFolder | null, unavailableFolder: string | null): void;
  /** Lists the folder again. */
  reload(): Promise<void>;
  /** Expands or collapses a folder. */
  toggle(path: ScriptPath): void;
  /** Creates an empty script named `name` (`.ppad` added when missing) and opens it. */
  newScript(parent: ScriptPath | null, name: string, language: LanguageId): Promise<ScriptPath>;
  newFolder(parent: ScriptPath | null, name: string): Promise<ScriptPath>;
  /** Renames an entry in place; scripts keep their `.ppad` extension. */
  rename(entry: TreeEntry, name: string): Promise<ScriptPath>;
  /** Moves an entry into `folder` (the root when `null`). */
  move(path: ScriptPath, folder: ScriptPath | null): Promise<ScriptPath>;
  /** Moves an entry to the operating system's trash. */
  remove(path: ScriptPath): Promise<void>;
  /**
   * Lets the user pick another scripts folder. Refused (`"unsaved"`) while scripts of the current
   * folder have unsaved changes; on a switch their tabs are closed and untitled ones kept.
   */
  chooseFolder(title: string): Promise<"changed" | "cancelled" | "unsaved">;
}

export function createExplorer(deps: { ipc: ExplorerIpc; workspace: Workspace }): Explorer {
  const { ipc, workspace } = deps;
  const store = createStore<ExplorerState>(() => ({
    folderName: null,
    tree: null,
    unavailableFolder: null,
    expanded: new Set(),
  }));

  function expand(path: ScriptPath | null): void {
    if (path === null) return;
    store.setState((state) => ({ expanded: new Set(state.expanded).add(path) }));
  }

  async function reload(): Promise<void> {
    store.setState({ tree: await ipc.listScripts() });
  }

  /** After `from` moved to `to`: tabs follow and expanded folders keep their state. */
  async function relocated(from: ScriptPath, to: ScriptPath): Promise<void> {
    workspace.moveTabs(from, to);
    store.setState((state) => ({
      expanded: new Set([...state.expanded].map((path) => movedPath(path, from, to) ?? path)),
    }));
    await reload();
  }

  return {
    store,

    load(folder, unavailableFolder) {
      store.setState({
        folderName: folder?.name ?? null,
        tree: folder?.tree ?? null,
        unavailableFolder,
        expanded: new Set(),
      });
    },

    reload,

    toggle(path) {
      store.setState((state) => {
        const expanded = new Set(state.expanded);
        if (!expanded.delete(path)) {
          expanded.add(path);
        }
        return { expanded };
      });
    },

    async newScript(parent, name, language) {
      const document: Document = { header: newHeader(language), code: "", newline: "lf" };
      const created = await ipc.createScript(parent, scriptFileName(name), document);
      expand(parent);
      await reload();
      await workspace.openScript(created.path);
      return created.path;
    },

    async newFolder(parent, name) {
      const path = await ipc.createFolder(parent, name.trim());
      expand(parent);
      await reload();
      return path;
    },

    async rename(entry, name) {
      const target = entry.kind === "script" ? scriptFileName(name) : name.trim();
      const renamed = await ipc.renameEntry(entry.path, target);
      await relocated(entry.path, renamed);
      return renamed;
    },

    async move(path, folder) {
      const moved = await ipc.moveEntry(path, folder);
      expand(folder);
      await relocated(path, moved);
      return moved;
    },

    async remove(path) {
      await ipc.deleteEntry(path);
      await reload();
      // Open tabs of what was deleted keep their text and are marked as missing.
      await workspace.reconcile({ paths: [], renamed: [], rescan: true });
    },

    async chooseFolder(title) {
      const { tabs } = workspace.store.getState();
      if (tabs.some((tab) => tab.path !== null && tab.modified)) {
        return "unsaved";
      }
      const folder = await ipc.chooseScriptsFolder(title);
      if (folder === null) {
        return "cancelled";
      }
      // Paths are relative to the scripts folder, so tabs of the old one no longer mean anything.
      for (const tab of workspace.store.getState().tabs) {
        if (tab.path !== null) {
          await workspace.discardAndClose(tab.id);
        }
      }
      store.setState({
        folderName: folder.name,
        tree: folder.tree,
        unavailableFolder: null,
        expanded: new Set(),
      });
      return "changed";
    },
  };
}
