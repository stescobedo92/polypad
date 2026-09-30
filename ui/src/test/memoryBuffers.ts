import type { TextBuffers } from "../features/workspace/textBuffers";
import type { BufferId, LanguageId } from "../shared/ipc";

interface Entry {
  language: LanguageId;
  saved: string;
  text: string;
}

/** Text buffers kept as strings; `edit` stands in for typing in the editor. */
export class MemoryBuffers implements TextBuffers {
  private readonly entries = new Map<BufferId, Entry>();
  private readonly listeners = new Set<(id: BufferId) => void>();

  create(id: BufferId, language: LanguageId, saved: string, current: string = saved): void {
    this.entries.set(id, { language, saved, text: current });
  }

  text(id: BufferId): string {
    return this.entry(id).text;
  }

  replace(id: BufferId, text: string): void {
    const entry = this.entry(id);
    entry.text = text;
    entry.saved = text;
  }

  markSaved(id: BufferId): void {
    const entry = this.entry(id);
    entry.saved = entry.text;
  }

  isModified(id: BufferId): boolean {
    const entry = this.entry(id);
    return entry.text !== entry.saved;
  }

  setLanguage(id: BufferId, language: LanguageId): void {
    this.entry(id).language = language;
  }

  dispose(id: BufferId): void {
    this.entries.delete(id);
  }

  onDidChange(listener: (id: BufferId) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Replaces the text as typing would, notifying listeners. */
  edit(id: BufferId, text: string): void {
    this.entry(id).text = text;
    this.listeners.forEach((listener) => {
      listener(id);
    });
  }

  language(id: BufferId): LanguageId {
    return this.entry(id).language;
  }

  has(id: BufferId): boolean {
    return this.entries.has(id);
  }

  private entry(id: BufferId): Entry {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new Error(`no buffer ${id}`);
    }
    return entry;
  }
}
