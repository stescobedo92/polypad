import { describe, expect, it } from "vitest";

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
