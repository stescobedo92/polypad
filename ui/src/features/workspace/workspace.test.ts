import { afterEach, describe, expect, it, vi } from "vitest";

import { CommandFailure } from "../../shared/ipc";
import { FakeBackend, headerFor } from "../../test/fakeBackend";
import { MemoryBuffers } from "../../test/memoryBuffers";
import { createWorkspace } from "./workspace";

function setup() {
  const backend = new FakeBackend();
  const buffers = new MemoryBuffers();
  let next = 0;
  const workspace = createWorkspace({
    ipc: backend,
    buffers,
    newId: () => {
      next += 1;
      return `b${String(next)}`;
    },
    now: () => 42,
  });
  const state = () => workspace.store.getState();
  const tab = (id: string) => state().tabs.find((candidate) => candidate.id === id);
  return { backend, buffers, workspace, state, tab };
}

describe("opening scripts", () => {
  it("opens a script in a new active tab with its header and text", async () => {
    const { backend, buffers, workspace, state } = setup();
    const stamp = backend.write("reports/q1.ppad", "print(1)\n", headerFor("python", "script"));

    await workspace.openScript("reports/q1.ppad");

    expect(state().activeId).toBe("b1");
    expect(state().tabs).toEqual([
      expect.objectContaining({
        id: "b1",
        path: "reports/q1.ppad",
        header: headerFor("python", "script"),
        baseStamp: stamp,
        modified: false,
        disk: "same",
      }),
    ]);
    expect(buffers.text("b1")).toBe("print(1)\n");
    expect(buffers.language("b1")).toBe("python");
  });

  it("activates the tab of a script that is already open", async () => {
    const { backend, workspace, state } = setup();
    backend.write("a.ppad", "a");
    backend.write("b.ppad", "b");
    await workspace.openScript("a.ppad");
    await workspace.openScript("b.ppad");

    await workspace.openScript("a.ppad");

    expect(state().tabs.map((t) => t.path)).toEqual(["a.ppad", "b.ppad"]);
    expect(state().activeId).toBe("b1");
  });

  it("opens nothing when the script cannot be read", async () => {
    const { workspace, state } = setup();

    await expect(workspace.openScript("missing.ppad")).rejects.toBeInstanceOf(CommandFailure);
    expect(state().tabs).toEqual([]);
  });
});

describe("new scripts", () => {
  it("are untitled, numbered, in the language's default mode and not modified", () => {
    const { workspace, state, buffers } = setup();

    workspace.newScript("python");
    workspace.newScript("go");

    expect(state().tabs).toEqual([
      expect.objectContaining({
        id: "b1",
        path: null,
        untitledNumber: 1,
        header: headerFor("python", "script"),
        modified: false,
      }),
      expect.objectContaining({ id: "b2", untitledNumber: 2, header: headerFor("go") }),
    ]);
    expect(state().activeId).toBe("b2");
    expect(buffers.text("b1")).toBe("");
  });
});

describe("closing tabs", () => {
  it("closes a clean tab, frees its buffer and activates a neighbour", async () => {
    const { backend, buffers, workspace, state } = setup();
    backend.write("a.ppad", "a");
    backend.write("b.ppad", "b");
    await workspace.openScript("a.ppad");
    await workspace.openScript("b.ppad");

    await expect(workspace.requestClose("b2")).resolves.toBe("closed");

    expect(state().tabs.map((t) => t.id)).toEqual(["b1"]);
    expect(state().activeId).toBe("b1");
    expect(buffers.has("b2")).toBe(false);
  });

  it("asks before closing a modified tab, and discarding forgets its unsaved work", async () => {
    const { backend, buffers, workspace, state } = setup();
    backend.write("a.ppad", "a");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "a changed");
    backend.journal.set("b1", {
      path: "a.ppad",
      baseStamp: null,
      document: { header: headerFor("csharp"), code: "a changed", newline: "lf" },
      updatedAt: 1,
    });

    await expect(workspace.requestClose("b1")).resolves.toBe("unsaved");
    expect(state().tabs).toHaveLength(1);

    await workspace.discardAndClose("b1");

    expect(state().tabs).toEqual([]);
    expect(state().activeId).toBeNull();
    expect(backend.journal.has("b1")).toBe(false);
  });
});

describe("the session", () => {
  it("records the open tabs in order and the active one", async () => {
    const { backend, workspace } = setup();
    backend.write("a.ppad", "a");
    await workspace.openScript("a.ppad");
    workspace.newScript("sql");
    workspace.activate("b1");
    await workspace.settled();

    expect(backend.session).toEqual({
      tabs: [
        { bufferId: "b1", path: "a.ppad" },
        { bufferId: "b2", path: null },
      ],
      active: "b1",
    });
  });
});

describe("saving", () => {
  it("writes text and header to the file and leaves the tab clean", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "old");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "new");
    backend.journal.set("b1", {
      path: "a.ppad",
      baseStamp: null,
      document: { header: headerFor("csharp"), code: "new", newline: "lf" },
      updatedAt: 1,
    });

    await expect(workspace.save("b1")).resolves.toBe("saved");

    expect(backend.code("a.ppad")).toBe("new");
    expect(tab("b1")).toEqual(
      expect.objectContaining({ modified: false, baseStamp: backend.files.get("a.ppad")?.stamp }),
    );
    await workspace.settled();
    expect(backend.journal.has("b1")).toBe(false);
  });

  it("keeps edits made while the save was in flight as unsaved", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "v1");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "v2");

    const saving = workspace.save("b1");
    buffers.edit("b1", "v3");
    await saving;

    expect(backend.code("a.ppad")).toBe("v2");
    expect(tab("b1")?.modified).toBe(true);
  });

  it("reports a conflict and keeps the file when it changed elsewhere", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "mine before");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "mine");
    const theirs = backend.write("a.ppad", "theirs");

    await expect(workspace.save("b1")).resolves.toBe("conflict");

    expect(backend.code("a.ppad")).toBe("theirs");
    expect(tab("b1")).toEqual(
      expect.objectContaining({ disk: "changed", diskStamp: theirs, modified: true }),
    );
  });

  it("overwrites the other change once the user keeps theirs", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "base");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "mine");
    backend.write("a.ppad", "theirs");
    await workspace.save("b1");

    workspace.keepMine("b1");
    await expect(workspace.save("b1")).resolves.toBe("saved");

    expect(backend.code("a.ppad")).toBe("mine");
    expect(tab("b1")?.disk).toBe("same");
  });

  it("recreates a file deleted elsewhere once the user keeps theirs", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "base");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "mine");
    backend.remove("a.ppad");

    await expect(workspace.save("b1")).resolves.toBe("conflict");
    expect(tab("b1")?.disk).toBe("missing");
    workspace.keepMine("b1");
    await workspace.save("b1");

    expect(backend.code("a.ppad")).toBe("mine");
  });

  it("reloads the file, discarding local changes", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "base");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "mine");
    backend.write("a.ppad", "theirs", headerFor("python", "script"));
    await workspace.save("b1");

    await workspace.reloadFromDisk("b1");

    expect(buffers.text("b1")).toBe("theirs");
    expect(tab("b1")).toEqual(
      expect.objectContaining({
        header: headerFor("python", "script"),
        modified: false,
        disk: "same",
      }),
    );
    expect(buffers.language("b1")).toBe("python");
  });
});

describe("saving untitled scripts", () => {
  it("needs a name first", async () => {
    const { workspace } = setup();
    workspace.newScript("go");

    await expect(workspace.save("b1")).resolves.toBe("needs-name");
  });

  it("creates the script under the chosen name and turns the tab into it", async () => {
    const { backend, buffers, workspace, tab } = setup();
    workspace.newScript("go");
    buffers.edit("b1", "package main");

    await expect(workspace.saveAs("b1", "tools", "scratch")).resolves.toBe("tools/scratch.ppad");

    expect(backend.code("tools/scratch.ppad")).toBe("package main");
    expect(tab("b1")).toEqual(
      expect.objectContaining({
        path: "tools/scratch.ppad",
        untitledNumber: null,
        modified: false,
      }),
    );
    await workspace.settled();
    expect(backend.session?.tabs).toEqual([{ bufferId: "b1", path: "tools/scratch.ppad" }]);
  });

  it("keeps the tab untitled when the name is taken", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("taken.ppad", "x");
    workspace.newScript("go");

    await expect(workspace.saveAs("b1", null, "taken.ppad")).rejects.toBeInstanceOf(CommandFailure);
    expect(tab("b1")?.path).toBeNull();
  });
});

describe("header changes", () => {
  it("switching language keeps an offered mode, else takes the default, and marks the tab", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "x", headerFor("csharp", "expression"));
    await workspace.openScript("a.ppad");

    workspace.setLanguage("b1", "java");
    expect(tab("b1")?.header).toEqual(headerFor("java", "expression"));
    // Go offers statements and program only.
    workspace.setLanguage("b1", "go");
    expect(tab("b1")?.header).toEqual(headerFor("go", "statements"));

    expect(tab("b1")?.modified).toBe(true);
    expect(buffers.language("b1")).toBe("go");
  });

  it("going back to the saved header leaves the tab clean", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("a.ppad", "x", headerFor("csharp"));
    await workspace.openScript("a.ppad");

    workspace.setMode("b1", "program");
    expect(tab("b1")?.modified).toBe(true);
    workspace.setMode("b1", "statements");

    expect(tab("b1")?.modified).toBe(false);
  });
});

describe("the recovery journal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records unsaved work once editing pauses", async () => {
    vi.useFakeTimers();
    const { backend, buffers, workspace } = setup();
    const stamp = backend.write("a.ppad", "saved");
    await workspace.openScript("a.ppad");

    buffers.edit("b1", "unsaved");
    await vi.advanceTimersByTimeAsync(300);
    await workspace.settled();

    expect(backend.journal.get("b1")).toEqual({
      path: "a.ppad",
      baseStamp: stamp,
      document: { header: headerFor("csharp"), code: "unsaved", newline: "lf" },
      updatedAt: 42,
    });
  });

  it("a save made before the pause is not undone by the pending write", async () => {
    vi.useFakeTimers();
    const { backend, buffers, workspace } = setup();
    backend.write("a.ppad", "saved");
    await workspace.openScript("a.ppad");

    buffers.edit("b1", "quick save");
    await workspace.save("b1");
    await vi.advanceTimersByTimeAsync(2000);
    await workspace.settled();

    expect(backend.journal.has("b1")).toBe(false);
  });

  it("forgets the work when edits are undone back to the saved text", async () => {
    vi.useFakeTimers();
    const { backend, buffers, workspace } = setup();
    backend.write("a.ppad", "saved");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "changed");
    await vi.advanceTimersByTimeAsync(300);

    buffers.edit("b1", "saved");
    await vi.advanceTimersByTimeAsync(300);
    await workspace.settled();

    expect(backend.journal.has("b1")).toBe(false);
  });

  it("records header changes too", async () => {
    vi.useFakeTimers();
    const { backend, workspace } = setup();
    backend.write("a.ppad", "x");
    await workspace.openScript("a.ppad");

    workspace.setMode("b1", "program");
    await vi.advanceTimersByTimeAsync(300);
    await workspace.settled();

    expect(backend.journal.get("b1")?.document.header.mode).toBe("program");
  });

  it("writes pending work immediately when flushed", async () => {
    const { backend, buffers, workspace } = setup();
    workspace.newScript("python");
    buffers.edit("b1", "draft");

    await workspace.flushJournal();

    expect(backend.journal.get("b1")?.document.code).toBe("draft");
  });
});
