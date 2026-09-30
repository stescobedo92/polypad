import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BufferSnapshot } from "../../shared/ipc";
import { headerFor } from "../../test/fakeBackend";
import { JournalWriter } from "./journal";

function snapshot(code: string): BufferSnapshot {
  return {
    path: "a.ppad",
    baseStamp: "s1",
    document: { header: headerFor("csharp"), code, newline: "lf" },
    updatedAt: 0,
  };
}

/** Records the journal operations in the order they complete. */
function recorder(options: { slowWrites?: boolean } = {}) {
  const log: string[] = [];
  const writer = new JournalWriter({
    write: async (id, snap) => {
      if (options.slowWrites === true) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      log.push(`write ${id} ${snap.document.code}`);
    },
    discard: (id) => {
      log.push(`discard ${id}`);
      return Promise.resolve();
    },
  });
  return { log, writer };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("JournalWriter", () => {
  it("writes the latest snapshot once edits pause for 300 ms", async () => {
    const { log, writer } = recorder();
    let code = "a";

    writer.schedule("b1", () => snapshot(code));
    await vi.advanceTimersByTimeAsync(200);
    code = "ab";
    writer.schedule("b1", () => snapshot(code));
    await vi.advanceTimersByTimeAsync(299);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);

    expect(log).toEqual(["write b1 ab"]);
  });

  it("writes at least once a second while edits keep coming", async () => {
    const { log, writer } = recorder();

    for (let elapsed = 0; elapsed < 1000; elapsed += 100) {
      writer.schedule("b1", () => snapshot(`t${String(elapsed)}`));
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(log).toEqual(["write b1 t900"]);
  });

  it("cancels a pending write when the buffer is discarded", async () => {
    const { log, writer } = recorder();

    writer.schedule("b1", () => snapshot("x"));
    writer.discard("b1");
    await vi.advanceTimersByTimeAsync(2000);

    expect(log).toEqual(["discard b1"]);
  });

  it("never lets a write in flight land after a discard", async () => {
    const { log, writer } = recorder({ slowWrites: true });

    writer.schedule("b1", () => snapshot("x"));
    await vi.advanceTimersByTimeAsync(300); // the write starts and takes 500 ms
    writer.discard("b1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(log).toEqual(["write b1 x", "discard b1"]);
  });

  it("discards instead of writing when the buffer is no longer modified", async () => {
    const { log, writer } = recorder();

    writer.schedule("b1", () => null);
    await vi.advanceTimersByTimeAsync(300);

    expect(log).toEqual(["discard b1"]);
  });

  it("flush writes everything pending at once and waits for it", async () => {
    const { log, writer } = recorder();
    writer.schedule("b1", () => snapshot("one"));
    writer.schedule("b2", () => snapshot("two"));

    await writer.flush();

    expect(log.sort()).toEqual(["write b1 one", "write b2 two"]);
  });

  it("reports a failed write once and keeps going", async () => {
    const failures: unknown[] = [];
    const writer = new JournalWriter({
      write: () => Promise.reject(new Error("disk full")),
      discard: () => Promise.resolve(),
      onFailure: (error) => failures.push(error),
    });

    writer.schedule("b1", () => snapshot("x"));
    writer.schedule("b2", () => snapshot("y"));
    await writer.flush();

    expect(failures).toHaveLength(2);
  });
});
