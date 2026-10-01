import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ScriptPath, TreeEntry } from "../../shared/ipc";
import { ScriptTree, type ScriptTreeProps } from "./ScriptTree";

const ENTRIES: TreeEntry[] = [
  {
    kind: "folder",
    path: "reports",
    name: "reports",
    children: [
      { kind: "folder", path: "reports/old", name: "old", children: [] },
      { kind: "script", path: "reports/q1.ppad", name: "q1.ppad" },
    ],
  },
  { kind: "script", path: "a.ppad", name: "a.ppad" },
  { kind: "script", path: "b.ppad", name: "b.ppad" },
];

function entryAt(path: ScriptPath, entries: TreeEntry[] = ENTRIES): TreeEntry {
  for (const entry of entries) {
    if (entry.path === path) return entry;
    if (entry.kind === "folder" && path.startsWith(`${entry.path}/`)) {
      return entryAt(path, entry.children);
    }
  }
  throw new Error(`no entry ${path}`);
}

function setup(initiallyExpanded: ScriptPath[] = []) {
  const handlers = {
    onOpen: vi.fn(),
    onNewScript: vi.fn(),
    onNewFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onMoveTo: vi.fn(),
  } satisfies Partial<ScriptTreeProps>;

  function Harness() {
    const [expanded, setExpanded] = useState<ReadonlySet<ScriptPath>>(new Set(initiallyExpanded));
    return (
      <ScriptTree
        label="Scripts"
        entries={ENTRIES}
        expanded={expanded}
        activePath="a.ppad"
        onToggle={(path) => {
          setExpanded((current) => {
            const next = new Set(current);
            if (!next.delete(path)) next.add(path);
            return next;
          });
        }}
        {...handlers}
      />
    );
  }

  render(<Harness />);
  const user = userEvent.setup();
  const item = (name: string) => screen.getByRole("treeitem", { name });
  const names = () => screen.getAllByRole("treeitem").map((element) => element.textContent);
  return { user, handlers, item, names };
}

/** A drag carries its data in an object jsdom does not provide. */
function dataTransfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "all",
    dropEffect: "none",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
}

describe("ScriptTree", () => {
  it("lists the entries in the order given, scripts without their extension", () => {
    const { names, item } = setup();

    expect(names()).toEqual(["reports", "a", "b"]);
    expect(item("reports")).toHaveAttribute("aria-expanded", "false");
    expect(item("a")).not.toHaveAttribute("aria-expanded");
    expect(item("a")).toHaveAttribute("aria-level", "1");
  });

  it("shows the contents of expanded folders one level deeper", () => {
    const { names, item } = setup(["reports"]);

    expect(names()).toEqual(["reports", "old", "q1", "a", "b"]);
    expect(item("reports")).toHaveAttribute("aria-expanded", "true");
    expect(item("q1")).toHaveAttribute("aria-level", "2");
  });

  it("marks the script of the active tab", () => {
    const { item } = setup();

    expect(item("a")).toHaveAttribute("aria-selected", "true");
    expect(item("b")).toHaveAttribute("aria-selected", "false");
  });

  it("keeps a single item in the tab order", () => {
    const { item } = setup();

    expect(item("reports")).toHaveAttribute("tabindex", "0");
    expect(item("a")).toHaveAttribute("tabindex", "-1");
  });

  it("moves through the visible items with the arrow keys, Home and End", async () => {
    const { user, item } = setup(["reports"]);
    item("reports").focus();

    await user.keyboard("{ArrowDown}");
    expect(item("old")).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(item("a")).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(item("q1")).toHaveFocus();
    await user.keyboard("{End}");
    expect(item("b")).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(item("b")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(item("reports")).toHaveFocus();
    expect(item("reports")).toHaveAttribute("tabindex", "0");
  });

  it("expands with the right arrow, then enters; the left arrow goes back and collapses", async () => {
    const { user, item, names } = setup();
    item("reports").focus();

    await user.keyboard("{ArrowRight}");
    expect(names()).toEqual(["reports", "old", "q1", "a", "b"]);
    expect(item("reports")).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(item("old")).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowLeft}");
    expect(item("reports")).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(names()).toEqual(["reports", "a", "b"]);
  });

  it("opens a script with Enter or a click, and toggles a folder", async () => {
    const { user, handlers, item, names } = setup();

    item("a").focus();
    await user.keyboard("{Enter}");
    await user.click(item("b"));
    expect(handlers.onOpen.mock.calls).toEqual([["a.ppad"], ["b.ppad"]]);

    await user.click(item("reports"));
    expect(names()).toEqual(["reports", "old", "q1", "a", "b"]);
    item("reports").focus();
    await user.keyboard("{Enter}");
    expect(names()).toEqual(["reports", "a", "b"]);
    expect(handlers.onOpen).toHaveBeenCalledTimes(2);
  });

  it("renames with F2 and deletes with Delete", async () => {
    const { user, handlers, item } = setup();
    item("a").focus();

    await user.keyboard("{F2}");
    await user.keyboard("{Delete}");

    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith(entryAt("a.ppad"));
    expect(handlers.onDelete).toHaveBeenCalledExactlyOnceWith(entryAt("a.ppad"));
  });

  it("offers the actions for an entry in a context menu", async () => {
    const { user, handlers, item } = setup(["reports"]);

    fireEvent.contextMenu(item("reports"));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((element) => element.textContent)).toEqual([
      "New script",
      "New folder",
      "Rename",
      "Move to…",
      "Move to trash",
    ]);
    await user.click(menu.getByRole("menuitem", { name: "New script" }));
    expect(handlers.onNewScript).toHaveBeenCalledExactlyOnceWith("reports");

    fireEvent.contextMenu(item("reports"));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(handlers.onRename).toHaveBeenCalledExactlyOnceWith(entryAt("reports"));
  });

  it("creates next to a script, and moves without a mouse through a dialog", async () => {
    const { user, handlers, item } = setup(["reports"]);

    fireEvent.contextMenu(item("q1"));
    await user.click(await screen.findByRole("menuitem", { name: "New folder" }));
    expect(handlers.onNewFolder).toHaveBeenCalledExactlyOnceWith("reports");

    fireEvent.contextMenu(item("q1"));
    await user.click(await screen.findByRole("menuitem", { name: "Move to…" }));
    expect(handlers.onMoveTo).toHaveBeenCalledExactlyOnceWith(entryAt("reports/q1.ppad"));
  });

  it("creates at the top level from the empty area", async () => {
    const { user, handlers } = setup();

    fireEvent.contextMenu(screen.getByRole("tree", { name: "Scripts" }));
    const menu = within(await screen.findByRole("menu"));
    expect(menu.getAllByRole("menuitem").map((element) => element.textContent)).toEqual([
      "New script",
      "New folder",
    ]);
    await user.click(menu.getByRole("menuitem", { name: "New folder" }));

    expect(handlers.onNewFolder).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("moves an entry dropped on a folder, or on the empty area for the top level", () => {
    const { handlers, item } = setup(["reports"]);
    const transfer = dataTransfer();

    fireEvent.dragStart(item("a"), { dataTransfer: transfer });
    fireEvent.dragOver(item("reports"), { dataTransfer: transfer });
    fireEvent.drop(item("reports"), { dataTransfer: transfer });
    expect(handlers.onMove).toHaveBeenLastCalledWith("a.ppad", "reports");

    fireEvent.dragStart(item("q1"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("tree"), { dataTransfer: transfer });
    expect(handlers.onMove).toHaveBeenLastCalledWith("reports/q1.ppad", null);
    expect(handlers.onMove).toHaveBeenCalledTimes(2);
  });

  it("ignores drops that would not move anything", () => {
    const { handlers, item } = setup(["reports"]);
    const transfer = dataTransfer();

    // Already there.
    fireEvent.dragStart(item("q1"), { dataTransfer: transfer });
    fireEvent.drop(item("reports"), { dataTransfer: transfer });
    fireEvent.dragStart(item("a"), { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("tree"), { dataTransfer: transfer });
    // Into itself or its own contents.
    fireEvent.dragStart(item("reports"), { dataTransfer: transfer });
    fireEvent.drop(item("reports"), { dataTransfer: transfer });
    fireEvent.dragStart(item("reports"), { dataTransfer: transfer });
    fireEvent.drop(item("old"), { dataTransfer: transfer });

    expect(handlers.onMove).not.toHaveBeenCalled();
  });
});
