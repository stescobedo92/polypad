import { describe, expect, it } from "vitest";

import { CommandFailure } from "../shared/ipc";
import { FakeBackend } from "../test/fakeBackend";
import { fakeEditor } from "../test/fakeEditor";
import { createActions, failureMessage } from "./actions";
import { startSession } from "./session";
import { createUi } from "./ui";

async function setup(prepare: (backend: FakeBackend) => void = () => undefined) {
  const backend = new FakeBackend();
  prepare(backend);
  const editor = fakeEditor();
  const session = await startSession({ ipc: backend, loadEditor: () => Promise.resolve(editor) });
  const ui = createUi();
  const actions = createActions(session, ui);
  const tabs = () => session.workspace.store.getState().tabs;
  const active = () => {
    const state = session.workspace.store.getState();
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    if (tab === undefined) throw new Error("no active tab");
    return tab;
  };
  const dialog = () => ui.getState().dialog;
  return { backend, editor, session, ui, actions, tabs, active, dialog };
}

describe("saving", () => {
  it("asks for a name before saving an untitled script, then saves it there", async () => {
    const { backend, editor, actions, active, dialog } = await setup();
    editor.buffers().edit(active().id, "SELECT 1");

    await actions.save(active().id);
    expect(dialog()).toEqual(expect.objectContaining({ kind: "name", purpose: "saveAs" }));

    await actions.submitName("queries");

    expect(backend.code("queries.ppad")).toBe("SELECT 1");
    expect(active().path).toBe("queries.ppad");
    expect(dialog()).toBeNull();
  });

  it("saves an untitled script into the folder chosen in the dialog", async () => {
    const { backend, session, actions, active } = await setup();
    await session.explorer.newFolder(null, "reports");

    await actions.save(active().id);
    await actions.submitName("q1", "reports");

    expect(backend.files.has("reports/q1.ppad")).toBe(true);
    expect(active().path).toBe("reports/q1.ppad");
  });

  it("keeps the name dialog open with the reason when the name is not accepted", async () => {
    const { backend, actions, active, dialog } = await setup((b) => {
      b.write("taken.ppad", "x");
    });

    await actions.save(active().id);
    await actions.submitName("taken");

    expect(dialog()).toEqual(
      expect.objectContaining({ kind: "name", error: { key: "errors.alreadyExists" } }),
    );
    expect(backend.code("taken.ppad")).toBe("x");
  });

  it("creates a script again when it was deleted on disk", async () => {
    const { backend, editor, session, actions, active } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    editor.buffers().edit(active().id, "kept");
    backend.remove("a.ppad");
    await session.workspace.reconcile({ paths: ["a.ppad"], renamed: [], rescan: false });
    expect(active().disk).toBe("missing");

    await actions.save(active().id);

    expect(backend.code("a.ppad")).toBe("kept");
    expect(active()).toEqual(expect.objectContaining({ disk: "same", modified: false }));
  });

  it("leaves a script that changed on disk alone until the conflict is resolved", async () => {
    const { backend, editor, session, actions, active } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    editor.buffers().edit(active().id, "mine");
    backend.write("a.ppad", "theirs");

    await actions.save(active().id);

    expect(backend.code("a.ppad")).toBe("theirs");
    expect(active().disk).toBe("changed");
  });

  it("saves a titled script directly", async () => {
    const { backend, editor, session, actions, active, dialog } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    editor.buffers().edit(active().id, "new");

    await actions.save(active().id);

    expect(backend.code("a.ppad")).toBe("new");
    expect(dialog()).toBeNull();
  });
});

describe("conflicts", () => {
  it("reloads the script from disk, and says so when that fails", async () => {
    const { backend, editor, session, ui, actions, active } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    const id = active().id;
    editor.buffers().edit(id, "mine");
    backend.write("a.ppad", "theirs");

    await actions.reloadFromDisk(id);
    expect(editor.buffers().text(id)).toBe("theirs");
    expect(ui.getState().notice).toBeNull();

    backend.remove("a.ppad");
    await actions.reloadFromDisk(id);
    expect(ui.getState().notice).toEqual({ key: "errors.notFound" });
  });
});

describe("closing tabs", () => {
  it("closes a clean tab at once", async () => {
    const { session, actions, tabs, dialog } = await setup((b) => {
      b.write("a.ppad", "x");
    });
    await session.workspace.openScript("a.ppad");
    const opened = tabs().find((tab) => tab.path === "a.ppad");

    await actions.closeTab(opened?.id ?? "");

    expect(tabs().some((tab) => tab.path === "a.ppad")).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("asks about unsaved changes; saving from the dialog saves and then closes", async () => {
    const { backend, editor, session, actions, tabs, active, dialog } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    const id = active().id;
    editor.buffers().edit(id, "edited");

    await actions.closeTab(id);
    expect(dialog()).toEqual({ kind: "unsaved", tabId: id });

    await actions.resolveUnsaved("save");

    expect(backend.code("a.ppad")).toBe("edited");
    expect(tabs().some((tab) => tab.id === id)).toBe(false);
    expect(dialog()).toBeNull();
  });

  it("discarding closes without saving, cancelling keeps the tab", async () => {
    const { backend, editor, session, actions, tabs, active } = await setup((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    const id = active().id;
    editor.buffers().edit(id, "edited");

    await actions.closeTab(id);
    await actions.resolveUnsaved("cancel");
    expect(tabs().some((tab) => tab.id === id)).toBe(true);

    await actions.closeTab(id);
    await actions.resolveUnsaved("discard");

    expect(tabs().some((tab) => tab.id === id)).toBe(false);
    expect(backend.code("a.ppad")).toBe("old");
  });

  it("saving an untitled tab from the dialog names it first, then closes it", async () => {
    const { backend, editor, actions, tabs, active, dialog } = await setup();
    const id = active().id;
    editor.buffers().edit(id, "draft");

    await actions.closeTab(id);
    await actions.resolveUnsaved("save");
    expect(dialog()).toEqual(expect.objectContaining({ kind: "name", purpose: "saveAs" }));
    await actions.submitName("draft");

    expect(backend.code("draft.ppad")).toBe("draft");
    expect(tabs().some((tab) => tab.id === id)).toBe(false);
  });
});

describe("new scripts", () => {
  it("use the language of the active tab and remember it", async () => {
    const { session, actions, active } = await setup();
    session.workspace.setLanguage(active().id, "go");

    actions.newScript();

    expect(active().header.language).toBe("go");
    expect(session.preferences().lastLanguage).toBe("go");
  });
});

describe("explorer actions", () => {
  it("creates a script through the name dialog and opens it", async () => {
    const { backend, actions, active, dialog } = await setup();

    actions.promptNewScript(null);
    expect(dialog()).toEqual(expect.objectContaining({ kind: "name", purpose: "newScript" }));
    await actions.submitName("orders");

    expect(backend.files.has("orders.ppad")).toBe(true);
    expect(active().path).toBe("orders.ppad");
  });

  it("renames through the name dialog, starting from the current name", async () => {
    const { backend, session, actions, dialog } = await setup((b) => {
      b.write("a.ppad", "x");
    });
    const [entry] = session.explorer.store.getState().tree?.entries ?? [];
    if (entry === undefined) throw new Error("empty tree");

    actions.promptRename(entry);
    expect(dialog()).toEqual(expect.objectContaining({ kind: "name", initial: "a" }));
    await actions.submitName("b");

    expect(backend.files.has("b.ppad")).toBe(true);
  });

  it("deletes only after confirmation", async () => {
    const { backend, session, actions, dialog } = await setup((b) => {
      b.write("a.ppad", "x");
    });
    const [entry] = session.explorer.store.getState().tree?.entries ?? [];
    if (entry === undefined) throw new Error("empty tree");

    actions.promptDelete(entry);
    expect(dialog()).toEqual({ kind: "confirmDelete", entry });
    expect(backend.files.has("a.ppad")).toBe(true);
    await actions.confirmDelete();

    expect(backend.trashed).toEqual(["a.ppad"]);
    expect(dialog()).toBeNull();
  });

  it("shows why a move failed", async () => {
    const { session, ui, actions } = await setup((b) => {
      b.write("a.ppad", "x");
      b.write("dir/a.ppad", "y");
    });
    await session.explorer.reload();

    await actions.move("a.ppad", "dir");

    expect(ui.getState().notice).toEqual({ key: "errors.alreadyExists" });
  });
});

describe("failure messages", () => {
  it("map every command error to a translatable message", () => {
    const message = (error: CommandFailure["error"]) => failureMessage(new CommandFailure(error));

    expect(message({ code: "conflict", path: "a.ppad", current: null })).toEqual({
      key: "errors.conflict",
    });
    expect(
      message({ code: "invalidName", problem: { kind: "invalidCharacter", character: ":" } }),
    ).toEqual({ key: "errors.invalidName.invalidCharacter", values: { character: ":" } });
    expect(message({ code: "invalidName", problem: { kind: "reservedName" } })).toEqual({
      key: "errors.invalidName.reservedName",
    });
    expect(
      message({
        code: "unsupportedDocument",
        path: "a.ppad",
        problem: { kind: "invalidHeader", line: 4, column: 3 },
      }),
    ).toEqual({ key: "errors.unsupportedDocument.invalidHeader", values: { line: 4, column: 3 } });
    expect(message({ code: "internal", reference: "E-1" })).toEqual({
      key: "errors.internal",
      values: { reference: "E-1" },
    });
    expect(failureMessage(new Error("boom"))).toEqual({
      key: "errors.internal",
      values: { reference: "ui" },
    });
  });
});
