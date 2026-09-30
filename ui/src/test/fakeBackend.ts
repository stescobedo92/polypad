import type { WorkspaceIpc } from "../features/workspace/workspace";
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
  type ScriptPath,
  type Session,
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
export class FakeBackend implements WorkspaceIpc {
  readonly files = new Map<ScriptPath, { document: Document; stamp: ContentStamp }>();
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

  private stamp(): ContentStamp {
    this.nextStamp += 1;
    return `stamp-${String(this.nextStamp)}`;
  }
}
