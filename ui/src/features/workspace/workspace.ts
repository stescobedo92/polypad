/**
 * Open scripts and what happens to them: opening, editing, closing, the session.
 *
 * The text of each tab lives in {@link TextBuffers}; this module keeps everything else in a
 * Zustand store and talks to Rust through {@link WorkspaceIpc}, so it is tested against an
 * in-memory backend without a WebView or an editor.
 */
import { createStore, type StoreApi } from "zustand/vanilla";

import {
  CommandFailure,
  type BufferId,
  type BufferSnapshot,
  type ContentStamp,
  type CreatedScript,
  type Document,
  type ExecutionMode,
  type Header,
  type LanguageId,
  type LoadedScript,
  type Newline,
  type RecoveredSession,
  type RecoveredTab,
  type ScriptChanges,
  type ScriptPath,
  type Session,
} from "../../shared/ipc";
import { findLanguage } from "../../shared/languages";
import { JournalWriter } from "./journal";
import type { TextBuffers } from "./textBuffers";

/** The commands the workspace needs; `shared/ipc` provides them in the app. */
export interface WorkspaceIpc {
  openScript(path: ScriptPath): Promise<LoadedScript>;
  scriptStatus(path: ScriptPath): Promise<ContentStamp | null>;
  saveScript(
    path: ScriptPath,
    document: Document,
    expected: ContentStamp | null,
  ): Promise<ContentStamp>;
  createScript(parent: ScriptPath | null, name: string, document: Document): Promise<CreatedScript>;
  journalBuffer(id: BufferId, snapshot: BufferSnapshot): Promise<void>;
  discardBuffer(id: BufferId): Promise<void>;
  setSession(session: Session): Promise<void>;
}

/** How the file on disk relates to the tab. */
export type DiskState =
  /** The file is what the tab was loaded from or last saved as. */
  | "same"
  /** Another program changed the file while the tab has unsaved changes. */
  | "changed"
  /** The file is gone; saving recreates it. */
  | "missing";

export interface Tab {
  readonly id: BufferId;
  /** The script; `null` for an untitled one. */
  readonly path: ScriptPath | null;
  /**
   * For work recovered from a scripts folder that is not open now: the script it edited there,
   * shown as a hint. Such a tab is untitled and can only be saved under a new name.
   */
  readonly previousPath: ScriptPath | null;
  /** Numbers untitled tabs ("Untitled 2"). */
  readonly untitledNumber: number | null;
  readonly header: Header;
  readonly newline: Newline;
  /** Stamp of the file the tab is based on; `null` when there is no file. */
  readonly baseStamp: ContentStamp | null;
  /** The tab differs from its file (text, header, or an upgrade applied while loading). */
  readonly modified: boolean;
  readonly disk: DiskState;
  /** Stamp of what is on disk when {@link disk} is `"changed"`. */
  readonly diskStamp: ContentStamp | null;
  /** Header as last saved or loaded; a different current header makes the tab modified. */
  readonly savedHeader: Header;
  /** Modified regardless of the text (loaded with an upgrade, or recovered from the journal). */
  readonly forcedModified: boolean;
}

export interface WorkspaceState {
  readonly tabs: readonly Tab[];
  readonly activeId: BufferId | null;
  /** A journal write failed: a crash could lose unsaved work (shown to the user once). */
  readonly journalFailed: boolean;
}

export interface WorkspaceDeps {
  readonly ipc: WorkspaceIpc;
  readonly buffers: TextBuffers;
  /** Creates buffer ids; random UUIDs by default. */
  readonly newId?: () => BufferId;
  /** Milliseconds since the Unix epoch, for journal snapshots. */
  readonly now?: () => number;
}

export interface Workspace {
  readonly store: StoreApi<WorkspaceState>;
  /** Opens `path`, or activates its tab when it is already open. */
  openScript(path: ScriptPath): Promise<void>;
  /** Opens an empty untitled script in `language`. */
  newScript(language: LanguageId): void;
  activate(id: BufferId): void;
  /** Closes a tab without unsaved changes; reports `"unsaved"` instead of closing a modified one. */
  requestClose(id: BufferId): Promise<"closed" | "unsaved">;
  /** Closes a tab and forgets its unsaved changes. */
  discardAndClose(id: BufferId): Promise<void>;
  /**
   * Saves a tab to its file. `"conflict"` means the file changed on disk since the tab read it
   * (it is left untouched); `"needs-name"` means the tab is untitled and needs {@link saveAs}.
   */
  save(id: BufferId): Promise<SaveOutcome>;
  /** Saves an untitled tab as `name` (`.ppad` is added when missing) in `parent`. */
  saveAs(id: BufferId, parent: ScriptPath | null, name: string): Promise<ScriptPath>;
  /** Resolves a conflict in favour of the tab: the next save overwrites or recreates the file. */
  keepMine(id: BufferId): void;
  /** Replaces the tab with the file on disk, discarding its unsaved changes. */
  reloadFromDisk(id: BufferId): Promise<void>;
  /** Switches the language, keeping the mode when the new language offers it. */
  setLanguage(id: BufferId, language: LanguageId): void;
  setMode(id: BufferId, mode: ExecutionMode): void;
  /** Updates the tabs of `from` (a script, or every script in a folder) now at `to`. */
  moveTabs(from: ScriptPath, to: ScriptPath): void;
  /**
   * Applies changes other programs made: tabs follow renamed files, tabs without unsaved changes
   * reload, tabs with unsaved changes are put in conflict, and deleted files are marked missing.
   * A rescan checks every open script.
   */
  reconcile(changes: ScriptChanges): Promise<void>;
  /**
   * Reopens the tabs of the previous session: clean ones from disk, unsaved ones from their
   * journal snapshot (with a conflict if the file changed meanwhile). Clean tabs whose file is
   * gone are skipped and reported.
   */
  restore(session: RecoveredSession): Promise<{ readonly skipped: readonly ScriptPath[] }>;
  /** Writes pending journal snapshots now (the window is closing). */
  flushJournal(): Promise<void>;
  /** Resolves once the background writes started so far have finished. */
  settled(): Promise<void>;
}

export type SaveOutcome = "saved" | "conflict" | "needs-name";

/** Where `path` ends up when `from` (a script or a folder) moves to `to`; `null` if unaffected. */
export function movedPath(path: ScriptPath, from: ScriptPath, to: ScriptPath): ScriptPath | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : null;
}

/** File name for a script called `name`: adds `.ppad` unless it is already there. */
export function scriptFileName(name: string): string {
  const trimmed = name.trim();
  return /\.ppad$/i.test(trimmed) ? trimmed : `${trimmed}.ppad`;
}

/** Header of a new script in `language`, as Rust writes it. */
export function newHeader(language: LanguageId): Header {
  return {
    language,
    mode: findLanguage(language).modes[0],
    connection: null,
    packages: [],
    imports: [],
    extra: "{}",
  };
}

function sameHeader(a: Header, b: Header): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function createWorkspace(deps: WorkspaceDeps): Workspace {
  const { ipc, buffers } = deps;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const now = deps.now ?? (() => Date.now());
  const store = createStore<WorkspaceState>(() => ({
    tabs: [],
    activeId: null,
    journalFailed: false,
  }));
  const journal = new JournalWriter({
    write: (id, snapshot) => ipc.journalBuffer(id, snapshot),
    discard: (id) => ipc.discardBuffer(id),
    onFailure: (error) => {
      console.warn("the recovery journal failed", error);
      store.setState({ journalFailed: true });
    },
  });
  /** Buffers that may have a journal entry, so clean buffers cause no discard calls. */
  const journaled = new Set<BufferId>();
  let untitledCount = 0;
  let pending: Promise<unknown> = Promise.resolve();
  /** The save of each tab in progress; the next one waits for it. */
  const saves = new Map<BufferId, Promise<SaveOutcome>>();

  const find = (id: BufferId) => store.getState().tabs.find((tab) => tab.id === id);

  function track(work: Promise<unknown>): void {
    pending = Promise.allSettled([pending, work]);
  }

  function updateTab(id: BufferId, change: (tab: Tab) => Tab): void {
    store.setState((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? change(tab) : tab)),
    }));
  }

  function refreshModified(id: BufferId): void {
    updateTab(id, (tab) => ({
      ...tab,
      modified:
        tab.forcedModified || buffers.isModified(id) || !sameHeader(tab.header, tab.savedHeader),
    }));
    if (find(id)?.modified === true) {
      journaled.add(id);
      journal.schedule(id, () => snapshotOf(id));
    } else {
      forgetJournal(id);
    }
  }

  /** What the journal keeps for a modified tab; `null` once there is nothing unsaved. */
  function snapshotOf(id: BufferId): BufferSnapshot | null {
    const tab = find(id);
    if (tab?.modified !== true) return null;
    return {
      path: tab.path,
      baseStamp: tab.baseStamp,
      document: documentOf(tab),
      updatedAt: now(),
    };
  }

  // Sessions are written one after another, each with the latest state, so a slow write can
  // never land after a newer one.
  let sessionWrites: Promise<unknown> = Promise.resolve();
  function persistSession(): void {
    sessionWrites = sessionWrites.then(() => {
      const { tabs, activeId } = store.getState();
      return ipc
        .setSession({
          tabs: tabs.map((tab) => ({ bufferId: tab.id, path: tab.path })),
          active: activeId,
        })
        .catch((error: unknown) => {
          // Without the session record, unsaved work would not be reopened after a crash.
          console.warn("cannot record the session", error);
          store.setState({ journalFailed: true });
        });
    });
    track(sessionWrites);
  }

  function forgetJournal(id: BufferId): void {
    if (journaled.delete(id)) {
      journal.discard(id);
    }
  }

  /** The tab's document as it would be written. */
  function documentOf(tab: Tab): Document {
    return { header: tab.header, code: buffers.text(tab.id), newline: tab.newline };
  }

  /** Records that `document` is now on disk with `stamp`. */
  function markSaved(id: BufferId, document: Document, stamp: ContentStamp): void {
    buffers.markSaved(id, document.code);
    updateTab(id, (tab) => ({
      ...tab,
      baseStamp: stamp,
      savedHeader: document.header,
      forcedModified: false,
      disk: "same",
      diskStamp: null,
    }));
    refreshModified(id);
  }

  function changeHeader(id: BufferId, change: (header: Header) => Header): void {
    const tab = find(id);
    if (tab === undefined) return;
    const header = change(tab.header);
    if (header.language !== tab.header.language) {
      buffers.setLanguage(id, header.language);
    }
    updateTab(id, (current) => ({ ...current, header }));
    refreshModified(id);
  }

  /**
   * Replaces a tab with its file. In the background (`keepEdits`), edits made while the file was
   * being read win: the tab is put in conflict instead of losing them.
   */
  async function reload(id: BufferId, keepEdits: boolean): Promise<void> {
    const path = find(id)?.path;
    if (path == null) return;
    const loaded = await ipc.openScript(path);
    const tab = find(id);
    // Closed or moved while the file was on its way.
    if (tab?.path !== path) return;
    if (keepEdits && tab.modified) {
      updateTab(id, (latest) => ({ ...latest, disk: "changed", diskStamp: loaded.stamp }));
      return;
    }
    const { header, code, newline } = loaded.document;
    buffers.replace(id, code);
    buffers.setLanguage(id, header.language);
    updateTab(id, (latest) => ({
      ...latest,
      header,
      newline,
      baseStamp: loaded.stamp,
      savedHeader: header,
      forcedModified: loaded.normalized,
      disk: "same",
      diskStamp: null,
    }));
    refreshModified(id);
  }

  /** Compares a tab with its file and reacts as {@link Workspace.reconcile} describes. */
  async function checkDisk(id: BufferId): Promise<void> {
    const before = find(id);
    const path = before?.path;
    if (path == null) return;
    let status: ContentStamp | null;
    try {
      status = await ipc.scriptStatus(path);
    } catch (error) {
      console.warn("cannot check a script on disk", error);
      return;
    }
    // Saved, renamed or closed while the status was on its way: the status says nothing about
    // the tab any more (a save's own result is what counts).
    const tab = find(id);
    if (tab?.path !== path || tab.baseStamp !== before?.baseStamp) return;
    if (status === tab.baseStamp) {
      if (tab.disk !== "same") {
        updateTab(id, (latest) => ({ ...latest, disk: "same", diskStamp: null }));
      }
    } else if (status === null) {
      updateTab(id, (latest) => ({ ...latest, disk: "missing", diskStamp: null }));
    } else if (tab.modified) {
      updateTab(id, (latest) => ({ ...latest, disk: "changed", diskStamp: status }));
    } else {
      await reload(id, true);
    }
  }

  async function saveNow(id: BufferId): Promise<SaveOutcome> {
    const tab = find(id);
    if (tab === undefined) return "saved";
    if (tab.path === null) return "needs-name";
    const document = documentOf(tab);
    try {
      const stamp = await ipc.saveScript(tab.path, document, tab.baseStamp);
      // Closed while the save was on its way: the file is written and there is no tab to update.
      if (find(id) !== undefined) markSaved(id, document, stamp);
      return "saved";
    } catch (error) {
      if (error instanceof CommandFailure && error.error.code === "conflict") {
        const current = error.error.current;
        updateTab(id, (latest) => ({
          ...latest,
          disk: current === null ? "missing" : "changed",
          diskStamp: current,
        }));
        return "conflict";
      }
      throw error;
    }
  }

  /** How the file of recovered work relates to the snapshot's base stamp. */
  async function diskOf(
    path: ScriptPath,
    baseStamp: ContentStamp | null,
  ): Promise<{ saved: Document | null; disk: DiskState; diskStamp: ContentStamp | null }> {
    try {
      const loaded = await ipc.openScript(path);
      const changed = loaded.stamp !== baseStamp;
      return {
        saved: loaded.document,
        disk: changed ? "changed" : "same",
        diskStamp: changed ? loaded.stamp : null,
      };
    } catch {
      // Unreadable or gone: the stamp alone tells which.
      const status = await ipc.scriptStatus(path).catch(() => null);
      if (status === null) {
        return { saved: null, disk: baseStamp === null ? "same" : "missing", diskStamp: null };
      }
      return {
        saved: null,
        disk: status === baseStamp ? "same" : "changed",
        diskStamp: status === baseStamp ? null : status,
      };
    }
  }

  async function restoreTab(recovered: RecoveredTab): Promise<Tab | null> {
    const { bufferId: id, path, previousPath, snapshot } = recovered;
    if (snapshot === null) {
      if (path === null) {
        return null;
      }
      let loaded: LoadedScript;
      try {
        loaded = await ipc.openScript(path);
      } catch {
        return null;
      }
      const { header, code, newline } = loaded.document;
      buffers.create(id, header.language, code);
      return {
        id,
        path,
        previousPath: null,
        untitledNumber: null,
        header,
        newline,
        baseStamp: loaded.stamp,
        modified: loaded.normalized,
        disk: "same",
        diskStamp: null,
        savedHeader: header,
        forcedModified: loaded.normalized,
      };
    }

    const { header, code, newline } = snapshot.document;
    const onDisk =
      path === null
        ? { saved: null, disk: "same" as const, diskStamp: null }
        : await diskOf(path, snapshot.baseStamp);
    // What is on disk is the saved state, so undoing the recovered work returns to it.
    buffers.create(id, header.language, onDisk.saved?.code ?? "", code);
    journaled.add(id);
    if (path === null) {
      untitledCount += 1;
    }
    const savedHeader = onDisk.saved?.header ?? header;
    return {
      id,
      path,
      previousPath,
      untitledNumber: path === null ? untitledCount : null,
      header,
      newline,
      baseStamp: path === null ? null : snapshot.baseStamp,
      modified: buffers.isModified(id) || !sameHeader(header, savedHeader),
      disk: onDisk.disk,
      diskStamp: onDisk.diskStamp,
      savedHeader,
      forcedModified: false,
    };
  }

  /** Moves the affected tabs; returns their new paths. */
  function moveTabs(from: ScriptPath, to: ScriptPath): ScriptPath[] {
    const moved: ScriptPath[] = [];
    for (const tab of store.getState().tabs) {
      const target = tab.path === null ? null : movedPath(tab.path, from, to);
      if (target === null) continue;
      // Another tab already shows the target: leave this one to the disk check.
      if (store.getState().tabs.some((other) => other.path === target)) continue;
      updateTab(tab.id, (latest) => ({ ...latest, path: target }));
      // Re-journals unsaved work under its new path.
      refreshModified(tab.id);
      moved.push(target);
    }
    if (moved.length > 0) {
      persistSession();
    }
    return moved;
  }

  function addTab(tab: Tab): void {
    store.setState((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
    persistSession();
  }

  function activate(id: BufferId): void {
    if (find(id) === undefined) return;
    store.setState({ activeId: id });
    persistSession();
  }

  function close(id: BufferId): void {
    const { tabs, activeId } = store.getState();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const remaining = tabs.filter((tab) => tab.id !== id);
    const neighbour = remaining[Math.min(index, remaining.length - 1)];
    store.setState({
      tabs: remaining,
      activeId: activeId === id ? (neighbour?.id ?? null) : activeId,
    });
    buffers.dispose(id);
    persistSession();
    forgetJournal(id);
  }

  buffers.onDidChange(refreshModified);

  return {
    store,

    async openScript(path) {
      const open = () => store.getState().tabs.find((tab) => tab.path === path);
      const existing = open();
      if (existing !== undefined) {
        activate(existing.id);
        return;
      }
      const loaded = await ipc.openScript(path);
      // Opened twice concurrently: keep the first tab.
      const raced = open();
      if (raced !== undefined) {
        activate(raced.id);
        return;
      }
      const id = newId();
      const { header, code, newline } = loaded.document;
      buffers.create(id, header.language, code);
      addTab({
        id,
        path,
        previousPath: null,
        untitledNumber: null,
        header,
        newline,
        baseStamp: loaded.stamp,
        modified: loaded.normalized,
        disk: "same",
        diskStamp: null,
        savedHeader: header,
        forcedModified: loaded.normalized,
      });
    },

    newScript(language) {
      const id = newId();
      untitledCount += 1;
      const header = newHeader(language);
      buffers.create(id, language, "");
      addTab({
        id,
        path: null,
        previousPath: null,
        untitledNumber: untitledCount,
        header,
        newline: "lf",
        baseStamp: null,
        modified: false,
        disk: "same",
        diskStamp: null,
        savedHeader: header,
        forcedModified: false,
      });
    },

    activate,

    requestClose(id) {
      const tab = find(id);
      if (tab?.modified === true) {
        return Promise.resolve("unsaved");
      }
      close(id);
      return Promise.resolve("closed");
    },

    discardAndClose(id) {
      close(id);
      return Promise.resolve();
    },

    async save(id) {
      // One save of a tab at a time, each from the stamp the previous one left: two saves in a
      // row (a held-down Ctrl+S, a slow disk) must not make the tab conflict with itself.
      // The first one starts at once, so it saves the text of the moment it was asked for.
      const previous = saves.get(id);
      const run =
        previous === undefined
          ? saveNow(id)
          : previous.then(
              () => saveNow(id),
              () => saveNow(id),
            );
      saves.set(id, run);
      try {
        return await run;
      } finally {
        if (saves.get(id) === run) saves.delete(id);
      }
    },

    async saveAs(id, parent, name) {
      const tab = find(id);
      if (tab === undefined) throw new Error(`no tab ${id}`);
      const document = documentOf(tab);
      const created = await ipc.createScript(parent, scriptFileName(name), document);
      updateTab(id, (latest) => ({
        ...latest,
        path: created.path,
        previousPath: null,
        untitledNumber: null,
      }));
      markSaved(id, document, created.stamp);
      persistSession();
      return created.path;
    },

    keepMine(id) {
      updateTab(id, (tab) =>
        tab.disk === "same"
          ? tab
          : { ...tab, baseStamp: tab.diskStamp, disk: "same", diskStamp: null },
      );
    },

    reloadFromDisk: (id) => reload(id, false),

    moveTabs(from, to) {
      moveTabs(from, to);
    },

    async reconcile(changes) {
      const moved = changes.renamed.flatMap(({ from, to }) => moveTabs(from, to));
      const mentioned = new Set<ScriptPath>([
        ...changes.paths,
        ...changes.renamed.map((pair) => pair.to),
        ...moved,
      ]);
      const affected = store
        .getState()
        .tabs.filter((tab) => tab.path !== null && (changes.rescan || mentioned.has(tab.path)));
      await Promise.all(affected.map((tab) => checkDisk(tab.id)));
    },

    setLanguage(id, language) {
      changeHeader(id, (header) => ({
        ...header,
        language,
        mode: findLanguage(language).modes.includes(header.mode)
          ? header.mode
          : findLanguage(language).modes[0],
      }));
    },

    setMode(id, mode) {
      changeHeader(id, (header) => ({ ...header, mode }));
    },

    async restore(session) {
      const skipped: ScriptPath[] = [];
      for (const recovered of session.tabs) {
        const tab = await restoreTab(recovered);
        if (tab === null) {
          if (recovered.path !== null) skipped.push(recovered.path);
          continue;
        }
        store.setState((state) => ({ tabs: [...state.tabs, tab] }));
      }
      const { tabs } = store.getState();
      store.setState({
        activeId: tabs.some((tab) => tab.id === session.active)
          ? session.active
          : (tabs.at(-1)?.id ?? null),
      });
      persistSession();
      return { skipped };
    },

    flushJournal() {
      return journal.flush();
    },

    async settled() {
      let current: Promise<unknown>;
      do {
        current = pending;
        await current;
      } while (current !== pending);
      await journal.whenIdle();
    },
  };
}
