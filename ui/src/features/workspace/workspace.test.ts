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

describe("changes made by other programs", () => {
  it("reload a tab without unsaved changes silently", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "old");
    await workspace.openScript("a.ppad");
    const theirs = backend.write("a.ppad", "new");

    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(buffers.text("b1")).toBe("new");
    expect(tab("b1")).toEqual(expect.objectContaining({ baseStamp: theirs, modified: false }));
  });

  it("put a tab with unsaved changes in conflict and keep its text", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "old");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "mine");
    const theirs = backend.write("a.ppad", "theirs");

    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(buffers.text("b1")).toBe("mine");
    expect(tab("b1")).toEqual(expect.objectContaining({ disk: "changed", diskStamp: theirs }));
  });

  it("mark a deleted file as missing and keep the text", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "kept");
    await workspace.openScript("a.ppad");
    backend.remove("a.ppad");

    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(tab("b1")?.disk).toBe("missing");
    expect(buffers.text("b1")).toBe("kept");
  });

  it("ignore the tab's own saves", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "old");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "saved by us");
    await workspace.save("b1");

    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(tab("b1")).toEqual(expect.objectContaining({ disk: "same", modified: false }));
  });

  it("clear a conflict once the file is back to the tab's version", async () => {
    const { backend, buffers, workspace, tab } = setup();
    backend.write("a.ppad", "old");
    await workspace.openScript("a.ppad");
    const base = backend.files.get("a.ppad");
    buffers.edit("b1", "mine");
    backend.write("a.ppad", "theirs");
    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });
    if (base !== undefined) backend.files.set("a.ppad", base);

    await workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(tab("b1")?.disk).toBe("same");
  });

  it("follow a script renamed elsewhere", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("a.ppad", "x");
    await workspace.openScript("a.ppad");
    const file = backend.files.get("a.ppad");
    backend.remove("a.ppad");
    if (file !== undefined) backend.files.set("renamed/b.ppad", file);

    await workspace.reconcile({
      paths: [],
      renamed: [{ from: "a.ppad", to: "renamed/b.ppad" }],
      rescan: false,
    });
    await workspace.settled();

    expect(tab("b1")).toEqual(expect.objectContaining({ path: "renamed/b.ppad", disk: "same" }));
    expect(backend.session?.tabs).toEqual([{ bufferId: "b1", path: "renamed/b.ppad" }]);
  });

  it("check every open script on a rescan", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("a.ppad", "a");
    backend.write("b.ppad", "b");
    await workspace.openScript("a.ppad");
    await workspace.openScript("b.ppad");
    backend.remove("a.ppad");
    backend.remove("b.ppad");

    await workspace.reconcile({ paths: [], renamed: [], rescan: true });

    expect([tab("b1")?.disk, tab("b2")?.disk]).toEqual(["missing", "missing"]);
  });
});

describe("restoring the previous session", () => {
  function unsaved(path: string | null, code: string, baseStamp: string | null) {
    return {
      path,
      baseStamp,
      document: { header: headerFor("csharp"), code, newline: "lf" as const },
      updatedAt: 1,
    };
  }

  it("reopens clean tabs from disk and unsaved ones from the journal, in order", async () => {
    const { backend, buffers, workspace, state, tab } = setup();
    const clean = backend.write("clean.ppad", "on disk");
    const edited = backend.write("edited.ppad", "disk version");

    const outcome = await workspace.restore({
      tabs: [
        { bufferId: "r1", path: "clean.ppad", previousPath: null, snapshot: null },
        {
          bufferId: "r2",
          path: "edited.ppad",
          previousPath: null,
          snapshot: unsaved("edited.ppad", "unsaved edit", edited),
        },
        {
          bufferId: "r3",
          path: null,
          previousPath: null,
          snapshot: unsaved(null, "untitled draft", null),
        },
      ],
      active: "r2",
    });

    expect(outcome.skipped).toEqual([]);
    expect(state().tabs.map((t) => t.id)).toEqual(["r1", "r2", "r3"]);
    expect(state().activeId).toBe("r2");
    expect(tab("r1")).toEqual(
      expect.objectContaining({ path: "clean.ppad", baseStamp: clean, modified: false }),
    );
    expect(tab("r2")).toEqual(
      expect.objectContaining({ baseStamp: edited, modified: true, disk: "same" }),
    );
    expect(buffers.text("r2")).toBe("unsaved edit");
    expect(tab("r3")).toEqual(
      expect.objectContaining({ path: null, untitledNumber: 1, modified: true }),
    );
    expect(buffers.text("r3")).toBe("untitled draft");
  });

  it("undoing recovered work returns to what is on disk", async () => {
    const { backend, buffers, workspace, tab } = setup();
    const stamp = backend.write("a.ppad", "disk version");
    await workspace.restore({
      tabs: [
        {
          bufferId: "r1",
          path: "a.ppad",
          previousPath: null,
          snapshot: unsaved("a.ppad", "unsaved", stamp),
        },
      ],
      active: null,
    });

    buffers.edit("r1", "disk version");

    expect(tab("r1")?.modified).toBe(false);
  });

  it("skips clean tabs whose file is gone and reports them", async () => {
    const { workspace, state } = setup();

    const outcome = await workspace.restore({
      tabs: [{ bufferId: "r1", path: "gone.ppad", previousPath: null, snapshot: null }],
      active: "r1",
    });

    expect(outcome.skipped).toEqual(["gone.ppad"]);
    expect(state().tabs).toEqual([]);
    expect(state().activeId).toBeNull();
  });

  it("shows a conflict when the file changed while PolyPad was closed", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("a.ppad", "base");
    const newer = backend.write("a.ppad", "changed while closed");

    await workspace.restore({
      tabs: [
        {
          bufferId: "r1",
          path: "a.ppad",
          previousPath: null,
          snapshot: unsaved("a.ppad", "mine", "stamp-1"),
        },
      ],
      active: null,
    });

    expect(tab("r1")).toEqual(expect.objectContaining({ disk: "changed", diskStamp: newer }));
  });

  it("marks recovered work missing when its file was deleted", async () => {
    const { workspace, tab, buffers } = setup();

    await workspace.restore({
      tabs: [
        {
          bufferId: "r1",
          path: "a.ppad",
          previousPath: null,
          snapshot: unsaved("a.ppad", "mine", "stamp-9"),
        },
      ],
      active: null,
    });

    expect(tab("r1")).toEqual(expect.objectContaining({ disk: "missing", modified: true }));
    expect(buffers.text("r1")).toBe("mine");
  });

  it("brings detached work back untitled with its previous path as a hint", async () => {
    const { backend, workspace, tab } = setup();
    backend.write("orders.ppad", "an unrelated script in this folder");

    await workspace.restore({
      tabs: [
        {
          bufferId: "r1",
          path: null,
          previousPath: "orders.ppad",
          snapshot: unsaved(null, "work from another folder", null),
        },
      ],
      active: null,
    });

    expect(tab("r1")).toEqual(
      expect.objectContaining({ path: null, previousPath: "orders.ppad", modified: true }),
    );
    await expect(workspace.save("r1")).resolves.toBe("needs-name");
  });

  it("forgets recovered work when its tab is discarded", async () => {
    const { backend, workspace } = setup();
    backend.journal.set("r1", unsaved(null, "draft", null));
    await workspace.restore({
      tabs: [
        { bufferId: "r1", path: null, previousPath: null, snapshot: unsaved(null, "draft", null) },
      ],
      active: null,
    });

    await workspace.discardAndClose("r1");
    await workspace.settled();

    expect(backend.journal.has("r1")).toBe(false);
  });
});
