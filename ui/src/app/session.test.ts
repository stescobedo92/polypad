import { afterEach, describe, expect, it, vi } from "vitest";

import { FakeBackend, headerFor } from "../test/fakeBackend";
import { fakeEditor } from "../test/fakeEditor";
import { startSession, type AppSession } from "./session";

const sessions: AppSession[] = [];

async function start(prepare: (backend: FakeBackend) => void = () => undefined) {
  const backend = new FakeBackend();
  prepare(backend);
  const editor = fakeEditor();
  const session = await startSession({ ipc: backend, loadEditor: () => Promise.resolve(editor) });
  sessions.push(session);
  const tabs = () => session.workspace.store.getState().tabs;
  return { backend, editor, session, tabs };
}

afterEach(() => {
  sessions.splice(0).forEach((session) => {
    session.dispose();
  });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The event types `target` still listens to, among those added after this call. */
function listenersLeftOn(target: EventTarget): () => string[] {
  const added = vi.spyOn(target, "addEventListener");
  const removed = vi.spyOn(target, "removeEventListener");
  return () =>
    added.mock.calls
      .filter(
        ([type, listener]) =>
          !removed.mock.calls.some(([gone, by]) => gone === type && by === listener),
      )
      .map(([type]) => type);
}

describe("a session that cannot start", () => {
  const refused = new Error("events are not allowed");

  /** Starts a session whose backend refuses flush requests; `prepare` sets up the rest. */
  function startRefused(prepare: (backend: FakeBackend) => void = () => undefined) {
    const backend = new FakeBackend();
    backend.onFlushRequested = () => Promise.reject(refused);
    prepare(backend);
    return startSession({ ipc: backend, loadEditor: () => Promise.resolve(fakeEditor()) });
  }

  it("leaves no listener on the window, the document or the colour scheme", async () => {
    const colourScheme = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", () => colourScheme);
    const left = [window, document, colourScheme].map(listenersLeftOn);

    await expect(startRefused()).rejects.toBe(refused);

    expect(left.map((listeners) => listeners())).toEqual([[], [], []]);
  });

  it("stops the subscription the backend did accept", async () => {
    const stop = vi.fn();

    await expect(
      startRefused((backend) => {
        backend.onScriptsChanged = () => Promise.resolve(stop);
      }),
    ).rejects.toBe(refused);

    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
  });

  it("stops a subscription accepted only after another was refused", async () => {
    const stop = vi.fn();
    let accept: () => void = () => undefined;

    await expect(
      startRefused((backend) => {
        backend.onScriptsChanged = () =>
          new Promise((resolve) => {
            accept = () => {
              resolve(stop);
            };
          });
      }),
    ).rejects.toBe(refused);
    expect(stop).not.toHaveBeenCalled();
    accept();

    await vi.waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
  });
});

describe("starting a session", () => {
  it("shows the scripts folder and reopens the previous tabs", async () => {
    const { session, tabs, editor } = await start((backend) => {
      const stamp = backend.write("a.ppad", "on disk");
      backend.recovered = {
        tabs: [
          {
            bufferId: "r1",
            path: "a.ppad",
            previousPath: null,
            snapshot: {
              path: "a.ppad",
              baseStamp: stamp,
              document: { header: headerFor("csharp"), code: "unsaved", newline: "lf" },
              updatedAt: 1,
            },
          },
        ],
        active: "r1",
      };
    });

    expect(session.explorer.store.getState().folderName).toBe("PolyPad");
    expect(session.explorer.store.getState().tree?.entries.map((e) => e.name)).toEqual(["a.ppad"]);
    expect(tabs()).toEqual([expect.objectContaining({ id: "r1", modified: true })]);
    expect(editor.buffers().text("r1")).toBe("unsaved");
  });

  it("opens an untitled script in the last language when nothing was recovered", async () => {
    const { tabs } = await start((backend) => {
      backend.preferences = { layout: {}, keybindings: {}, lastLanguage: "python" };
    });

    expect(tabs()).toEqual([
      expect.objectContaining({ path: null, header: headerFor("python", "script") }),
    ]);
  });

  it("reports tabs it could not reopen and a scripts folder that was unavailable", async () => {
    const { session } = await start((backend) => {
      backend.unavailableFolder = "Scripts";
      backend.recovered = {
        tabs: [{ bufferId: "r1", path: "gone.ppad", previousPath: null, snapshot: null }],
        active: null,
      };
    });

    expect(session.notices.skipped).toEqual(["gone.ppad"]);
    expect(session.explorer.store.getState().unavailableFolder).toBe("Scripts");
  });
});

describe("a running session", () => {
  it("reloads the tree and reconciles tabs when other programs change scripts", async () => {
    const { backend, session, tabs } = await start((b) => {
      b.write("a.ppad", "old");
    });
    await session.workspace.openScript("a.ppad");
    backend.write("a.ppad", "new");
    backend.write("b.ppad", "added");

    backend.emitScriptsChanged({ paths: ["a.ppad", "b.ppad"], renamed: [], rescan: false });
    await vi.waitFor(() => {
      expect(session.explorer.store.getState().tree?.entries).toHaveLength(2);
    });

    const opened = tabs().find((tab) => tab.path === "a.ppad");
    await vi.waitFor(() => {
      expect(opened && session.buffers.text(opened.id)).toBe("new");
    });
  });

  it("checks every open script when the window regains focus", async () => {
    const { backend, session, tabs } = await start((b) => {
      b.write("a.ppad", "x");
    });
    await session.workspace.openScript("a.ppad");
    backend.remove("a.ppad");

    window.dispatchEvent(new Event("focus"));

    await vi.waitFor(() => {
      expect(tabs().find((tab) => tab.path === "a.ppad")?.disk).toBe("missing");
    });
  });

  it("checks every open script when the window becomes visible again", async () => {
    const { backend, session, tabs } = await start((b) => {
      b.write("a.ppad", "x");
    });
    await session.workspace.openScript("a.ppad");
    backend.remove("a.ppad");

    document.dispatchEvent(new Event("visibilitychange"));

    await vi.waitFor(() => {
      expect(tabs().find((tab) => tab.path === "a.ppad")?.disk).toBe("missing");
    });
  });

  it("writes unsaved work before letting the window close", async () => {
    const { backend, editor, tabs } = await start();
    const [untitled] = tabs();
    if (untitled === undefined) throw new Error("no tab");
    editor.buffers().edit(untitled.id, "typed just before closing");

    backend.requestFlush();

    await vi.waitFor(() => {
      expect(backend.closed).toBe(true);
    });
    expect(backend.journal.get(untitled.id)?.document.code).toBe("typed just before closing");
  });

  it("writes pending preferences and the session record before the window closes", async () => {
    const { backend, session } = await start();
    const order: string[] = [];
    let finishSession: () => void = () => undefined;
    backend.setSession = () =>
      new Promise<void>((resolve) => {
        finishSession = () => {
          order.push("session");
          resolve();
        };
      });
    const ready = backend.readyToClose.bind(backend);
    backend.readyToClose = () => {
      order.push("closed");
      return ready();
    };

    session.updatePreferences((p) => ({ ...p, lastLanguage: "go" }));
    session.workspace.newScript("go");
    backend.requestFlush();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);
    finishSession();

    await vi.waitFor(() => {
      expect(backend.closed).toBe(true);
    });
    expect(order).toEqual(["session", "closed"]);
    expect(backend.preferences.lastLanguage).toBe("go");
  });

  it("saves preferences shortly after they change, once", async () => {
    vi.useFakeTimers();
    const { backend, session } = await start();

    session.updatePreferences((p) => ({ ...p, layout: { workspace: { explorer: 20, main: 80 } } }));
    session.updatePreferences((p) => ({ ...p, lastLanguage: "go" }));
    expect(backend.preferences.lastLanguage).toBeNull();
    await vi.advanceTimersByTimeAsync(500);

    expect(backend.preferences).toEqual({
      layout: { workspace: { explorer: 20, main: 80 } },
      keybindings: {},
      lastLanguage: "go",
    });
  });

  it("stops reacting once disposed", async () => {
    const { backend, session, tabs } = await start((b) => {
      b.write("a.ppad", "x");
    });
    await session.workspace.openScript("a.ppad");
    session.dispose();
    backend.remove("a.ppad");

    backend.emitScriptsChanged({ paths: [], renamed: [], rescan: true });
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();

    expect(tabs().find((tab) => tab.path === "a.ppad")?.disk).toBe("same");
  });
});
