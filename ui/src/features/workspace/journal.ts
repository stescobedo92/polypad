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
  /** Snapshots whose write failed and was not followed by a newer one, tried again on flush. */
  private readonly failed = new Map<BufferId, Pending["snapshot"]>();

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
    this.failed.delete(id);
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
    this.failed.delete(id);
    this.enqueue(id, () => this.deps.discard(id));
  }

  /**
   * Writes every pending snapshot now, tries failed writes once more (a Windows lock may have
   * gone) and waits for all operations to finish.
   */
  async flush(): Promise<void> {
    for (const [id, current] of [...this.pending]) {
      clearTimeout(current.timer);
      this.fire(id);
    }
    await Promise.all(this.chains.values());
    for (const [id, snapshot] of [...this.failed]) {
      this.failed.delete(id);
      this.write(id, snapshot, false);
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
    this.write(id, current.snapshot, true);
  }

  /** Writes what `snapshot` gives when its turn comes; `remember` keeps it for a retry. */
  private write(id: BufferId, snapshot: Pending["snapshot"], remember: boolean): void {
    this.enqueue(id, async () => {
      const taken = snapshot();
      if (taken === null) {
        await this.deps.discard(id);
        return;
      }
      try {
        await this.deps.write(id, taken);
      } catch (error) {
        // Unless a newer snapshot is already on its way.
        if (remember && !this.pending.has(id)) this.failed.set(id, snapshot);
        throw error;
      }
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
