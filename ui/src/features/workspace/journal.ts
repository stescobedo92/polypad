/**
 * Writes unsaved buffers to the recovery journal (docs/adr/0007).
 *
 * Snapshots are debounced: written 300 ms after the last edit, and at least once a second while
 * edits keep coming, which bounds what a crash can lose. Operations on one buffer run strictly
 * one after another, so a write held up by a Windows file lock can never land after the discard
 * that followed it (which would bring a saved buffer back as unsaved after a restart).
 */
import type { BufferId, BufferSnapshot } from "../../shared/ipc";

/** Pause after the last edit before a snapshot is written. */
export const JOURNAL_DEBOUNCE_MS = 300;
/** Longest a pending snapshot waits while edits keep coming. */
export const JOURNAL_MAX_WAIT_MS = 1000;

export interface JournalDeps {
  write(id: BufferId, snapshot: BufferSnapshot): Promise<void>;
  discard(id: BufferId): Promise<void>;
  /** Called for every failed operation; the writer keeps going. */
  onFailure?(error: unknown): void;
}

interface Pending {
  /** Takes the snapshot when the write happens; `null` means "nothing unsaved any more". */
  readonly snapshot: () => BufferSnapshot | null;
  readonly timer: ReturnType<typeof setTimeout>;
  /** When the first edit of this burst was scheduled, for the maximum wait. */
  readonly firstAt: number;
}

export class JournalWriter {
  private readonly pending = new Map<BufferId, Pending>();
  private readonly chains = new Map<BufferId, Promise<void>>();

  private readonly deps: JournalDeps;

  constructor(deps: JournalDeps) {
    this.deps = deps;
  }

  /** Schedules a snapshot of `id`, replacing any pending one. */
  schedule(id: BufferId, snapshot: () => BufferSnapshot | null): void {
    const now = Date.now();
    const current = this.pending.get(id);
    if (current !== undefined) {
      clearTimeout(current.timer);
    }
    const firstAt = current?.firstAt ?? now;
    const delay = Math.max(0, Math.min(JOURNAL_DEBOUNCE_MS, JOURNAL_MAX_WAIT_MS - (now - firstAt)));
    const timer = setTimeout(() => {
      this.fire(id);
    }, delay);
    this.pending.set(id, { snapshot, timer, firstAt });
  }

  /** Cancels a pending snapshot and removes the journaled one, after any operation in flight. */
  discard(id: BufferId): void {
    const current = this.pending.get(id);
    if (current !== undefined) {
      clearTimeout(current.timer);
      this.pending.delete(id);
    }
    this.enqueue(id, () => this.deps.discard(id));
  }

  /** Writes every pending snapshot now and waits for all operations to finish. */
  async flush(): Promise<void> {
    for (const [id, current] of [...this.pending]) {
      clearTimeout(current.timer);
      this.fire(id);
    }
    await Promise.all(this.chains.values());
  }

  /** Waits for the operations already started, without forcing pending snapshots. */
  async whenIdle(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private fire(id: BufferId): void {
    const current = this.pending.get(id);
    if (current === undefined) return;
    this.pending.delete(id);
    this.enqueue(id, () => {
      const snapshot = current.snapshot();
      return snapshot === null ? this.deps.discard(id) : this.deps.write(id, snapshot);
    });
  }

  private enqueue(id: BufferId, operation: () => Promise<void>): void {
    const previous = this.chains.get(id) ?? Promise.resolve();
    const next = previous.then(operation).catch((error: unknown) => {
      this.deps.onFailure?.(error);
    });
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) {
        this.chains.delete(id);
      }
    });
  }
}
