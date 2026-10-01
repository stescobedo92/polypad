import type { SessionIpc } from "../app/session";
import {
  CommandFailure,
  type BufferId,
  type BufferSnapshot,
  type ContentStamp,
  type CreatedScript,
  type Document,
  type Header,
  type LanguageId,
  type LoadedScript,
  type RecoveredSession,
  type ScriptChanges,
  type ScriptPath,
  type ScriptsFolder,
  type ScriptTree,
  type Session,
  type TreeEntry,
  type UiPreferences,
  type WorkspaceSnapshot,
} from "../shared/ipc";

/** A header as Rust writes it for a new script. */
export function headerFor(language: LanguageId, mode: Header["mode"] = "statements"): Header {
  return { language, mode, connection: null, packages: [], imports: [], extra: "{}" };
}

export function documentOf(code: string, header: Header = headerFor("csharp")): Document {
  return { header, code, newline: "lf" };
}

/**
 * The Rust workspace commands over an in-memory folder: content stamps, conflict checks and
 * the recovery journal behave as in `polypad-core`.
 */
export class FakeBackend implements SessionIpc {
  readonly files = new Map<ScriptPath, { document: Document; stamp: ContentStamp }>();
  /** Folders created explicitly (folders holding files exist implicitly). */
  readonly folders = new Set<ScriptPath>();
  /** What the next folder picker returns; `null` means cancelled. */
  nextPickedFolder: ScriptsFolder | null = null;
  readonly trashed: ScriptPath[] = [];
  /** What the previous run left in the journal, returned by the start-up snapshot. */
  recovered: RecoveredSession = { tabs: [], active: null };
  preferences: UiPreferences = { layout: {}, keybindings: {}, lastLanguage: null };
  unavailableFolder: string | null = null;
  recoveryAvailable = true;
  /** Set once the UI answered a flush request. */
  closed = false;
  private readonly changeListeners = new Set<(changes: ScriptChanges) => void>();
  private readonly flushListeners = new Set<() => void>();
  readonly journal = new Map<BufferId, BufferSnapshot>();
  session: Session | null = null;
  private nextStamp = 0;

  /** Puts a script on disk as another program would. */
  write(path: ScriptPath, code: string, header: Header = headerFor("csharp")): ContentStamp {
    const stamp = this.stamp();
    this.files.set(path, { document: documentOf(code, header), stamp });
    return stamp;
  }

  /** Deletes a script as another program would. */
  remove(path: ScriptPath): void {
    this.files.delete(path);
  }

  code(path: ScriptPath): string | undefined {
    return this.files.get(path)?.document.code;
  }

  openScript(path: ScriptPath): Promise<LoadedScript> {
    const file = this.files.get(path);
    if (file === undefined) {
      return Promise.reject(new CommandFailure({ code: "notFound", path }));
    }
    return Promise.resolve({ document: file.document, normalized: false, stamp: file.stamp });
  }

  scriptStatus(path: ScriptPath): Promise<ContentStamp | null> {
    return Promise.resolve(this.files.get(path)?.stamp ?? null);
  }

  saveScript(
    path: ScriptPath,
    document: Document,
    expected: ContentStamp | null,
  ): Promise<ContentStamp> {
    const current = this.files.get(path)?.stamp ?? null;
    if (current !== expected) {
      return Promise.reject(new CommandFailure({ code: "conflict", path, current }));
    }
    const stamp = this.stamp();
    this.files.set(path, { document, stamp });
    return Promise.resolve(stamp);
  }

  createScript(
    parent: ScriptPath | null,
    name: string,
    document: Document,
  ): Promise<CreatedScript> {
    const path = parent === null ? name : `${parent}/${name}`;
    if (this.files.has(path)) {
      return Promise.reject(new CommandFailure({ code: "alreadyExists", path }));
    }
    const stamp = this.stamp();
    this.files.set(path, { document, stamp });
    return Promise.resolve({ path, stamp });
  }

  journalBuffer(id: BufferId, snapshot: BufferSnapshot): Promise<void> {
    this.journal.set(id, snapshot);
    return Promise.resolve();
  }

  discardBuffer(id: BufferId): Promise<void> {
    this.journal.delete(id);
    return Promise.resolve();
  }

  setSession(session: Session): Promise<void> {
    this.session = session;
    return Promise.resolve();
  }

  async workspaceSnapshot(): Promise<WorkspaceSnapshot> {
    return {
      preferences: this.preferences,
      scriptsFolder: { name: "PolyPad", tree: await this.listScripts() },
      session: this.recovered,
      recoveryAvailable: this.recoveryAvailable,
      unavailableFolder: this.unavailableFolder,
    };
  }

  updatePreferences(preferences: UiPreferences): Promise<void> {
    this.preferences = preferences;
    return Promise.resolve();
  }

  readyToClose(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  onScriptsChanged(handler: (changes: ScriptChanges) => void): Promise<() => void> {
    this.changeListeners.add(handler);
    return Promise.resolve(() => this.changeListeners.delete(handler));
  }

  onFlushRequested(handler: () => void): Promise<() => void> {
    this.flushListeners.add(handler);
    return Promise.resolve(() => this.flushListeners.delete(handler));
  }

  /** Reports a batch of external changes, as the Rust watcher does. */
  emitScriptsChanged(changes: ScriptChanges): void {
    this.changeListeners.forEach((listener) => {
      listener(changes);
    });
  }

  /** Asks the UI to flush, as Rust does when the window is closing. */
  requestFlush(): void {
    this.flushListeners.forEach((listener) => {
      listener();
    });
  }

  listScripts(): Promise<ScriptTree> {
    return Promise.resolve({ entries: this.children(null), truncated: false });
  }

  createFolder(parent: ScriptPath | null, name: string): Promise<ScriptPath> {
    const invalid = this.invalidName(name);
    if (invalid !== null) return Promise.reject(invalid);
    const path = parent === null ? name : `${parent}/${name}`;
    if (this.exists(path)) {
      return Promise.reject(new CommandFailure({ code: "alreadyExists", path }));
    }
    this.folders.add(path);
    return Promise.resolve(path);
  }

  renameEntry(path: ScriptPath, name: string): Promise<ScriptPath> {
    const invalid = this.invalidName(name);
    if (invalid !== null) return Promise.reject(invalid);
    const slash = path.lastIndexOf("/");
    const target = slash < 0 ? name : `${path.slice(0, slash)}/${name}`;
    return this.relocate(path, target);
  }

  moveEntry(path: ScriptPath, folder: ScriptPath | null): Promise<ScriptPath> {
    const name = path.slice(path.lastIndexOf("/") + 1);
    return this.relocate(path, folder === null ? name : `${folder}/${name}`);
  }

  deleteEntry(path: ScriptPath): Promise<void> {
    if (!this.exists(path)) {
      return Promise.reject(new CommandFailure({ code: "notFound", path }));
    }
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key);
    }
    for (const key of [...this.folders]) {
      if (key === path || key.startsWith(`${path}/`)) this.folders.delete(key);
    }
    this.trashed.push(path);
    return Promise.resolve();
  }

  chooseScriptsFolder(): Promise<ScriptsFolder | null> {
    return Promise.resolve(this.nextPickedFolder);
  }

  private relocate(from: ScriptPath, to: ScriptPath): Promise<ScriptPath> {
    if (!this.exists(from)) {
      return Promise.reject(new CommandFailure({ code: "notFound", path: from }));
    }
    if (this.exists(to)) {
      return Promise.reject(new CommandFailure({ code: "alreadyExists", path: to }));
    }
    const move = (key: ScriptPath) =>
      key === from ? to : key.startsWith(`${from}/`) ? `${to}${key.slice(from.length)}` : key;
    for (const [key, file] of [...this.files]) {
      this.files.delete(key);
      this.files.set(move(key), file);
    }
    for (const key of [...this.folders]) {
      this.folders.delete(key);
      this.folders.add(move(key));
    }
    return Promise.resolve(to);
  }

  private exists(path: ScriptPath): boolean {
    return (
      this.files.has(path) ||
      this.folders.has(path) ||
      [...this.files.keys(), ...this.folders].some((key) => key.startsWith(`${path}/`))
    );
  }

  private invalidName(name: string): CommandFailure | null {
    const bad = Array.from(name).find((character) => ':/\\*?"<>|'.includes(character));
    return bad === undefined
      ? null
      : new CommandFailure({
          code: "invalidName",
          problem: { kind: "invalidCharacter", character: bad },
        });
  }

  /** Entries directly inside `folder`, folders first, then by name. */
  private children(folder: ScriptPath | null): TreeEntry[] {
    const prefix = folder === null ? "" : `${folder}/`;
    const names = new Map<string, "folder" | "script">();
    for (const key of [...this.folders, ...this.files.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      const isFolder = slash >= 0 || this.folders.has(key);
      names.set(slash >= 0 ? rest.slice(0, slash) : rest, isFolder ? "folder" : "script");
    }
    return [...names]
      .sort(([a, kindA], [b, kindB]) =>
        kindA === kindB ? a.localeCompare(b) : kindA === "folder" ? -1 : 1,
      )
      .map(([name, kind]) =>
        kind === "folder"
          ? { kind, name, path: `${prefix}${name}`, children: this.children(`${prefix}${name}`) }
          : { kind, name, path: `${prefix}${name}` },
      );
  }

  private stamp(): ContentStamp {
    this.nextStamp += 1;
    return `stamp-${String(this.nextStamp)}`;
  }
}
