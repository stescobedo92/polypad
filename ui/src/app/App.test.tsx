import { mockIPC } from "@tauri-apps/api/mocks";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppInfo } from "../shared/ipc";
import { FakeBackend } from "../test/fakeBackend";
import { FAKE_EDITOR_LABEL, fakeEditor } from "../test/fakeEditor";
import { App } from "./App";
import { startApp, type AppServices } from "./services";

const APP_INFO: AppInfo = {
  name: "PolyPad",
  version: "9.9.9",
  protocolVersion: "1.0",
  os: "windows",
  arch: "x86_64",
};

const started: Promise<AppServices>[] = [];

afterEach(async () => {
  for (const services of started.splice(0)) {
    (await services.catch(() => null))?.session.dispose();
  }
});

function mockAppInfo() {
  mockIPC((command) => {
    if (command === "app_info") return APP_INFO;
    throw new Error(`unexpected command: ${command}`);
  });
}

/** Renders the window over an in-memory backend and waits until it is usable. */
async function renderApp(prepare: (backend: FakeBackend) => void = () => undefined) {
  mockAppInfo();
  const backend = new FakeBackend();
  prepare(backend);
  const editor = fakeEditor();
  const starting = startApp({ ipc: backend, loadEditor: () => Promise.resolve(editor) });
  started.push(starting);
  const view = render(<App starting={starting} />);
  const user = userEvent.setup();
  await screen.findByRole("tablist", { name: "Open scripts" });
  const services = await starting;

  const scriptTabs = () =>
    within(screen.getByRole("tablist", { name: "Open scripts" }))
      .queryAllByRole("tab")
      .map((tab) => tab.getAttribute("aria-label"));
  const editorText = () => screen.getByLabelText<HTMLTextAreaElement>(FAKE_EDITOR_LABEL);
  const treeItem = (name: string) => screen.findByRole("treeitem", { name });
  return { backend, editor, services, user, view, scriptTabs, editorText, treeItem };
}

describe("starting up", () => {
  it("says the editor is loading, then lays out the regions of the main window", async () => {
    mockAppInfo();
    let finish: (services: AppServices) => void = () => undefined;
    const pending = new Promise<AppServices>((resolve) => {
      finish = resolve;
    });
    const ready = startApp({
      ipc: new FakeBackend(),
      loadEditor: () => Promise.resolve(fakeEditor()),
    });
    started.push(ready);

    render(<App starting={pending} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading the editor…");
    expect(screen.getByRole("navigation", { name: "Application menu" })).toBeInTheDocument();

    finish(await ready);

    expect(await screen.findByRole("complementary", { name: "Explorer" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Code editor" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByRole("contentinfo", { name: "Status" })).toBeInTheDocument();
    expect(screen.queryByText("Loading the editor…")).toBeNull();
  });

  it("says so when the workspace cannot be opened", async () => {
    mockAppInfo();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<App starting={Promise.reject(new Error("no backend"))} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "PolyPad could not open its workspace.",
    );
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });

  it("shows the version reported by the Rust side", async () => {
    await renderApp();

    expect(await screen.findByText("PolyPad 9.9.9")).toBeInTheDocument();
  });

  it("opens an untitled script and lists the scripts folder", async () => {
    const { scriptTabs, treeItem } = await renderApp((backend) => {
      backend.write("orders.ppad", "SELECT 1");
    });

    expect(scriptTabs()).toEqual(["Untitled 1"]);
    expect(await treeItem("orders")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "My scripts" })).getByText("PolyPad"),
    ).toBeInTheDocument();
  });

  it("tells which scripts of the last session are gone, until dismissed", async () => {
    const { user } = await renderApp((backend) => {
      backend.recovered = {
        tabs: [{ bufferId: "r1", path: "gone.ppad", previousPath: null, snapshot: null }],
        active: null,
      };
    });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(
      "These scripts from the last session no longer exist: gone.ppad.",
    );
    await user.click(within(notice).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("explains that another scripts folder is shown when the chosen one is unavailable", async () => {
    await renderApp((backend) => {
      backend.unavailableFolder = "Team scripts";
    });

    expect(
      screen.getByText("The folder “Team scripts” is not available, so this one is shown instead."),
    ).toBeInTheDocument();
  });

  it("warns that unsaved work is not protected when recovery is unavailable", async () => {
    const { user } = await renderApp((backend) => {
      backend.recoveryAvailable = false;
    });

    expect(screen.getByText(/Crash recovery is not working/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText(/Crash recovery is not working/)).toBeNull();
  });
});

describe("editing", () => {
  it("marks a tab as having unsaved changes once its text is edited", async () => {
    const { user, scriptTabs, editorText } = await renderApp();

    await user.type(editorText(), "dump(1)");

    expect(scriptTabs()).toEqual(["Untitled 1, unsaved changes"]);
  });

  it("shows the text of the tab that is selected", async () => {
    const { user, editorText, treeItem } = await renderApp((backend) => {
      backend.write("a.ppad", "from a");
    });

    await user.click(await treeItem("a"));
    await waitFor(() => {
      expect(editorText()).toHaveValue("from a");
    });

    await user.click(screen.getByRole("tab", { name: "Untitled 1" }));
    expect(editorText()).toHaveValue("");
    expect(screen.getByRole("tab", { name: "Untitled 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("re-tints the window and resets the mode when the language changes", async () => {
    const { user, view, scriptTabs } = await renderApp();
    const frame = view.container.firstElementChild;
    expect(frame).toHaveAttribute("data-language", "csharp");

    await user.selectOptions(screen.getByLabelText("Language"), "python");

    expect(frame).toHaveAttribute("data-language", "python");
    expect(screen.getByLabelText("Mode")).toHaveValue("script");
    const status = within(screen.getByRole("contentinfo"));
    expect(status.getByText("Python")).toBeInTheDocument();
    expect(status.getByText("Script")).toBeInTheDocument();
    expect(scriptTabs()).toEqual(["Untitled 1, unsaved changes"]);
  });

  it("shows the line endings of the script in the status bar", async () => {
    const { user, treeItem } = await renderApp((backend) => {
      backend.write("win.ppad", "a");
      const file = backend.files.get("win.ppad");
      if (file) file.document = { ...file.document, newline: "crlf" };
    });
    const status = within(screen.getByRole("contentinfo"));
    expect(status.getByText("LF")).toBeInTheDocument();

    await user.click(await treeItem("win"));

    expect(await status.findByText("CRLF")).toBeInTheDocument();
  });

  it("opens new scripts with the button and with Ctrl+N", async () => {
    const { user, scriptTabs } = await renderApp();

    await user.click(screen.getByRole("button", { name: "New script (Ctrl+N)" }));
    await user.keyboard("{Control>}n{/Control}");

    expect(scriptTabs()).toEqual(["Untitled 1", "Untitled 2", "Untitled 3"]);
    expect(screen.getByRole("tab", { name: "Untitled 3" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers to start a script when none is open", async () => {
    const { user, scriptTabs } = await renderApp();

    await user.keyboard("{Control>}w{/Control}");
    await waitFor(() => {
      expect(scriptTabs()).toEqual([]);
    });
    expect(screen.getByLabelText("Language")).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Start a new script" }));

    expect(scriptTabs()).toEqual([expect.stringMatching(/^Untitled \d+$/)]);
    expect(screen.getByLabelText("Language")).toBeEnabled();
  });
});

describe("saving and closing", () => {
  it("asks for a name with Ctrl+S, saves there and lists the new script", async () => {
    const { backend, user, scriptTabs, editorText, treeItem } = await renderApp();
    await user.type(editorText(), "SELECT 1");

    await user.keyboard("{Control>}s{/Control}");
    const dialog = within(await screen.findByRole("dialog", { name: "Save script" }));
    await user.type(dialog.getByLabelText("Name"), "queries");
    await user.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(scriptTabs()).toEqual(["queries"]);
    });
    expect(backend.code("queries.ppad")).toBe("SELECT 1");
    expect(await treeItem("queries")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("can save into a folder of the scripts tree", async () => {
    const { backend, user } = await renderApp((b) => {
      b.folders.add("reports");
    });

    await user.keyboard("{Control>}s{/Control}");
    const dialog = within(await screen.findByRole("dialog", { name: "Save script" }));
    await user.type(dialog.getByLabelText("Name"), "q1");
    await user.selectOptions(dialog.getByLabelText("Folder"), "reports");
    await user.click(dialog.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(backend.files.has("reports/q1.ppad")).toBe(true);
    });
  });

  it("explains why a name is not accepted and keeps the dialog open", async () => {
    const { user } = await renderApp((backend) => {
      backend.write("taken.ppad", "x");
    });

    await user.keyboard("{Control>}s{/Control}");
    const dialog = within(await screen.findByRole("dialog", { name: "Save script" }));
    await user.type(dialog.getByLabelText("Name"), "taken{Enter}");

    expect(await dialog.findByRole("alert")).toHaveTextContent("That name is already taken.");
    expect(dialog.getByLabelText("Name")).toHaveValue("taken");
  });

  it("closes a clean tab with its button, and asks before closing an edited one", async () => {
    const { user, scriptTabs, editorText } = await renderApp();
    await user.click(screen.getByRole("button", { name: "New script (Ctrl+N)" }));
    await user.type(editorText(), "draft");

    await user.click(screen.getByRole("button", { name: "Close Untitled 1" }));
    await waitFor(() => {
      expect(scriptTabs()).toEqual(["Untitled 2, unsaved changes"]);
    });

    await user.click(screen.getByRole("button", { name: "Close Untitled 2" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unsaved changes" }));
    expect(dialog.getByText("Save the changes to Untitled 2 before closing?")).toBeInTheDocument();
    await user.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(scriptTabs()).toEqual(["Untitled 2, unsaved changes"]);

    await user.keyboard("{Control>}w{/Control}");
    await user.click(await screen.findByRole("button", { name: "Don't save" }));
    await waitFor(() => {
      expect(scriptTabs()).toEqual([]);
    });
  });

  it("does not run shortcuts behind a dialog", async () => {
    const { user, scriptTabs } = await renderApp();

    await user.keyboard("{Control>}s{/Control}");
    await screen.findByRole("dialog", { name: "Save script" });
    await user.keyboard("{Control>}n{/Control}");

    expect(scriptTabs()).toEqual(["Untitled 1"]);
  });
});

describe("changes made by other programs", () => {
  async function openEdited() {
    const app = await renderApp((backend) => {
      backend.write("a.ppad", "old");
    });
    await app.user.click(await app.treeItem("a"));
    await waitFor(() => {
      expect(app.editorText()).toHaveValue("old");
    });
    await app.user.type(app.editorText(), " mine");
    return app;
  }

  it("offer to reload a script that changed on disk while it had unsaved changes", async () => {
    const { backend, user, scriptTabs, editorText } = await openEdited();

    backend.write("a.ppad", "theirs");
    backend.emitScriptsChanged({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(await screen.findByText("This script changed on disk.")).toBeInTheDocument();
    expect(scriptTabs()).toContain("a, unsaved changes, changed on disk");
    await user.click(screen.getByRole("button", { name: "Reload from disk" }));

    await waitFor(() => {
      expect(editorText()).toHaveValue("theirs");
    });
    expect(screen.queryByText("This script changed on disk.")).toBeNull();
    expect(scriptTabs()).toContain("a");
  });

  it("let the user keep their version and overwrite the file", async () => {
    const { backend, user } = await openEdited();
    backend.write("a.ppad", "theirs");
    backend.emitScriptsChanged({ paths: ["a.ppad"], renamed: [], rescan: false });

    await user.click(await screen.findByRole("button", { name: "Keep my changes" }));
    expect(screen.queryByText("This script changed on disk.")).toBeNull();
    await user.keyboard("{Control>}s{/Control}");

    await waitFor(() => {
      expect(backend.code("a.ppad")).toBe("old mine");
    });
  });

  it("say when a script was deleted, and saving creates it again", async () => {
    const { backend, user, scriptTabs } = await openEdited();
    backend.remove("a.ppad");
    backend.emitScriptsChanged({ paths: ["a.ppad"], renamed: [], rescan: false });

    expect(
      await screen.findByText("This script was deleted on disk. Saving creates it again."),
    ).toBeInTheDocument();
    expect(scriptTabs()).toContain("a, unsaved changes, deleted on disk");
    await user.click(screen.getByRole("button", { name: "Save again" }));

    await waitFor(() => {
      expect(backend.code("a.ppad")).toBe("old mine");
    });
    expect(screen.queryByText(/deleted on disk/)).toBeNull();
  });
});

describe("the scripts folder", () => {
  it("creates a script from the explorer and opens it", async () => {
    const { backend, user, scriptTabs } = await renderApp();

    await user.click(screen.getByRole("button", { name: "New script" }));
    const dialog = within(await screen.findByRole("dialog", { name: "New script" }));
    await user.type(dialog.getByLabelText("Name"), "orders{Enter}");

    await waitFor(() => {
      expect(scriptTabs()).toEqual(["Untitled 1", "orders"]);
    });
    expect(backend.files.has("orders.ppad")).toBe(true);
  });

  it("renames the script of an open tab from the tree", async () => {
    const { backend, user, scriptTabs, treeItem } = await renderApp((b) => {
      b.write("a.ppad", "x");
    });
    await user.click(await treeItem("a"));

    (await treeItem("a")).focus();
    await user.keyboard("{F2}");
    const dialog = within(await screen.findByRole("dialog", { name: "Rename" }));
    const name = dialog.getByLabelText("Name");
    expect(name).toHaveValue("a");
    await user.clear(name);
    await user.type(name, "b{Enter}");

    await waitFor(() => {
      expect(scriptTabs()).toEqual(["Untitled 1", "b"]);
    });
    expect(backend.files.has("b.ppad")).toBe(true);
  });

  it("moves a script to the trash only after confirming", async () => {
    const { backend, user, treeItem } = await renderApp((b) => {
      b.write("a.ppad", "x");
    });

    (await treeItem("a")).focus();
    await user.keyboard("{Delete}");
    const dialog = within(await screen.findByRole("dialog", { name: "Move to trash" }));
    expect(dialog.getByText("Move a to the trash?")).toBeInTheDocument();
    expect(backend.trashed).toEqual([]);
    await user.click(dialog.getByRole("button", { name: "Move to trash" }));

    await waitFor(() => {
      expect(backend.trashed).toEqual(["a.ppad"]);
    });
    await waitFor(() => {
      expect(screen.queryByRole("treeitem", { name: "a" })).toBeNull();
    });
  });

  it("shows why an action failed", async () => {
    const { services } = await renderApp((backend) => {
      backend.write("a.ppad", "x");
      backend.write("dir/a.ppad", "y");
    });

    await services.actions.move("a.ppad", "dir");

    expect(await screen.findByRole("alert")).toHaveTextContent("That name is already taken.");
  });

  it("switches to the folder the user picks", async () => {
    const { backend, user, treeItem } = await renderApp((b) => {
      b.write("a.ppad", "x");
    });
    backend.nextPickedFolder = {
      name: "Work",
      tree: { entries: [{ kind: "script", path: "w.ppad", name: "w.ppad" }], truncated: false },
    };

    await user.click(screen.getByRole("button", { name: "Choose scripts folder…" }));

    expect(await treeItem("w")).toBeInTheDocument();
    expect(screen.queryByRole("treeitem", { name: "a" })).toBeNull();
    expect(
      within(screen.getByRole("region", { name: "My scripts" })).getByText("Work"),
    ).toBeInTheDocument();
  });
});

describe("results", () => {
  it("switches result tabs with the arrow keys", async () => {
    const { user } = await renderApp();

    const results = within(screen.getByRole("region", { name: "Results" }));
    await user.click(results.getByRole("tab", { name: "Results" }));
    await user.keyboard("{ArrowRight}");

    const sqlTab = results.getByRole("tab", { name: "SQL" });
    expect(sqlTab).toHaveAttribute("aria-selected", "true");
    expect(sqlTab).toHaveFocus();
    expect(results.getByRole("tabpanel")).toHaveTextContent(
      "SQL generated by your script appears here.",
    );

    await user.keyboard("{End}");
    expect(results.getByRole("tab", { name: "Log" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(results.getByRole("tab", { name: "Results" })).toHaveFocus();
  });
});
