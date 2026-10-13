import { describe, expect, it, vi } from "vitest";

import { CommandFailure } from "../../shared/ipc";
import { FakeBackend, headerFor } from "../../test/fakeBackend";
import { MemoryBuffers } from "../../test/memoryBuffers";
import { createWorkspace } from "../workspace/workspace";
import { createExplorer } from "./explorer";

async function setup() {
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
  const explorer = createExplorer({ ipc: backend, workspace });
  explorer.load({ name: "PolyPad", tree: await backend.listScripts() }, null);
  const names = () => (explorer.store.getState().tree?.entries ?? []).map((entry) => entry.name);
  const tabs = () => workspace.store.getState().tabs;
  return { backend, buffers, workspace, explorer, names, tabs };
}

/** Holds listings back, as a slow disk would; calling an entry lets that listing arrive. */
function holdListings(backend: FakeBackend): (() => void)[] {
  const list = backend.listScripts.bind(backend);
  const held: (() => void)[] = [];
  backend.listScripts = async () => {
    // What the folder holds when the listing is asked for.
    const tree = await list();
    await new Promise<void>((resolve) => held.push(resolve));
    return tree;
  };
  return held;
}

describe("the scripts tree", () => {
  it("shows the folder it was loaded with and picks up changes on reload", async () => {
    const { backend, explorer, names } = await setup();
    expect(explorer.store.getState().folderName).toBe("PolyPad");
    expect(names()).toEqual([]);

    backend.write("b.ppad", "b");
    backend.write("reports/a.ppad", "a");
    await explorer.reload();

    expect(names()).toEqual(["reports", "b.ppad"]);
  });

  it("remembers which folders are expanded", async () => {
    const { explorer } = await setup();

    explorer.toggle("reports");
    expect(explorer.store.getState().expanded.has("reports")).toBe(true);
    explorer.toggle("reports");

    expect(explorer.store.getState().expanded.has("reports")).toBe(false);
  });
});

describe("listings that overlap", () => {
  async function twoListings() {
    const context = await setup();
    const held = holdListings(context.backend);
    context.backend.write("a.ppad", "a");
    const older = context.explorer.reload();
    context.backend.write("b.ppad", "b");
    const newer = context.explorer.reload();
    await vi.waitFor(() => {
      expect(held).toHaveLength(2);
    });
    return { ...context, held, older, newer };
  }

  it("keep the newest one when an older one arrives after it", async () => {
    const { held, older, newer, names } = await twoListings();

    held[1]?.();
    await newer;
    held[0]?.();
    await older;

    expect(names()).toEqual(["a.ppad", "b.ppad"]);
  });

  it("show each one as it arrives when they arrive in order", async () => {
    const { held, older, newer, names } = await twoListings();

    held[0]?.();
    await older;
    expect(names()).toEqual(["a.ppad"]);
    held[1]?.();
    await newer;

    expect(names()).toEqual(["a.ppad", "b.ppad"]);
  });
});

describe("creating entries", () => {
  it("creates an empty script in the language's default mode, opens it and expands its folder", async () => {
    const { backend, explorer, tabs } = await setup();
    await explorer.newFolder(null, "tools");

    const path = await explorer.newScript("tools", "scratch", "python");

    expect(path).toBe("tools/scratch.ppad");
    expect(backend.files.get(path)?.document).toEqual({
      header: headerFor("python", "script"),
      code: "",
      newline: "lf",
    });
    expect(tabs().map((tab) => tab.path)).toEqual(["tools/scratch.ppad"]);
    expect(explorer.store.getState().expanded.has("tools")).toBe(true);
  });

  it("refuses a taken name without opening anything", async () => {
    const { backend, explorer, tabs } = await setup();
    backend.write("a.ppad", "keep");

    await expect(explorer.newScript(null, "a", "go")).rejects.toBeInstanceOf(CommandFailure);

    expect(backend.code("a.ppad")).toBe("keep");
    expect(tabs()).toEqual([]);
  });

  it("passes on why a name is invalid", async () => {
    const { explorer } = await setup();

    const failure = await explorer.newFolder(null, "a:b").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommandFailure);
    expect((failure as CommandFailure).error).toEqual({
      code: "invalidName",
      problem: { kind: "invalidCharacter", character: ":" },
    });
  });
});

describe("renaming and moving", () => {
  it("renames a script, keeping .ppad, and its open tab follows", async () => {
    const { backend, workspace, explorer, names, tabs } = await setup();
    backend.write("a.ppad", "a");
    await explorer.reload();
    await workspace.openScript("a.ppad");
    const [entry] = explorer.store.getState().tree?.entries ?? [];
    if (entry === undefined) throw new Error("the tree is empty");

    await explorer.rename(entry, "b");

    expect(names()).toEqual(["b.ppad"]);
    expect(tabs().map((tab) => tab.path)).toEqual(["b.ppad"]);
  });

  it("renames a folder: tabs inside follow and it stays expanded", async () => {
    const { backend, workspace, explorer, tabs } = await setup();
    backend.write("old/a.ppad", "a");
    await explorer.reload();
    explorer.toggle("old");
    await workspace.openScript("old/a.ppad");
    const [folder] = explorer.store.getState().tree?.entries ?? [];
    if (folder === undefined) throw new Error("the tree is empty");

    await explorer.rename(folder, "new");

    expect(tabs().map((tab) => tab.path)).toEqual(["new/a.ppad"]);
    expect([...explorer.store.getState().expanded]).toEqual(["new"]);
  });

  it("moves a script into a folder and back to the root", async () => {
    const { backend, workspace, explorer, tabs } = await setup();
    backend.write("a.ppad", "a");
    await explorer.newFolder(null, "archive");
    await workspace.openScript("a.ppad");

    await explorer.move("a.ppad", "archive");
    expect(tabs().map((tab) => tab.path)).toEqual(["archive/a.ppad"]);
    expect(explorer.store.getState().expanded.has("archive")).toBe(true);

    await explorer.move("archive/a.ppad", null);
    expect(backend.files.has("a.ppad")).toBe(true);
  });
});

describe("deleting", () => {
  it("sends the entry to the trash and marks its open tabs as missing", async () => {
    const { backend, workspace, explorer, names, tabs } = await setup();
    backend.write("reports/a.ppad", "a");
    await explorer.reload();
    await workspace.openScript("reports/a.ppad");

    await explorer.remove("reports");

    expect(backend.trashed).toEqual(["reports"]);
    expect(names()).toEqual([]);
    expect(tabs()[0]?.disk).toBe("missing");
  });
});

describe("choosing another scripts folder", () => {
  it("is refused while scripts of the current folder have unsaved changes", async () => {
    const { backend, buffers, workspace, explorer } = await setup();
    backend.write("a.ppad", "a");
    await workspace.openScript("a.ppad");
    buffers.edit("b1", "unsaved");
    backend.nextPickedFolder = { name: "Other", tree: { entries: [], truncated: false } };

    await expect(explorer.chooseFolder("Choose")).resolves.toBe("unsaved");

    expect(explorer.store.getState().folderName).toBe("PolyPad");
  });

  it("switches, closing the old folder's tabs and keeping untitled ones", async () => {
    const { backend, workspace, explorer, tabs } = await setup();
    backend.write("a.ppad", "a");
    await workspace.openScript("a.ppad");
    workspace.newScript("sql");
    backend.nextPickedFolder = {
      name: "Other",
      tree: { entries: [{ kind: "script", name: "x.ppad", path: "x.ppad" }], truncated: false },
    };

    await expect(explorer.chooseFolder("Choose")).resolves.toBe("changed");

    expect(explorer.store.getState()).toEqual(
      expect.objectContaining({ folderName: "Other", unavailableFolder: null }),
    );
    expect(explorer.store.getState().tree?.entries.map((e) => e.name)).toEqual(["x.ppad"]);
    expect(tabs().map((tab) => tab.path)).toEqual([null]);
  });

  it("drops a listing of the previous folder that arrives after the switch", async () => {
    const { backend, explorer, names } = await setup();
    backend.write("a.ppad", "a");
    const held = holdListings(backend);
    const stale = explorer.reload();
    await vi.waitFor(() => {
      expect(held).toHaveLength(1);
    });
    backend.nextPickedFolder = {
      name: "Other",
      tree: { entries: [{ kind: "script", name: "x.ppad", path: "x.ppad" }], truncated: false },
    };

    await explorer.chooseFolder("Choose");
    held[0]?.();
    await stale;

    expect(explorer.store.getState().folderName).toBe("Other");
    expect(names()).toEqual(["x.ppad"]);
  });

  it("changes nothing when the dialog is cancelled", async () => {
    const { backend, explorer } = await setup();
    backend.nextPickedFolder = null;

    await expect(explorer.chooseFolder("Choose")).resolves.toBe("cancelled");

    expect(explorer.store.getState().folderName).toBe("PolyPad");
  });
});
