import { ChevronDown, ChevronRight, FileCode, Folder, FolderOpen } from "lucide-react";
import { ContextMenu } from "radix-ui";
import { useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { ScriptPath, TreeEntry } from "../../shared/ipc";
import { scriptTitle } from "../../shared/scripts";

export interface ScriptTreeProps {
  /** Accessible name of the tree. */
  readonly label: string;
  readonly entries: readonly TreeEntry[];
  /** Folders shown with their contents. */
  readonly expanded: ReadonlySet<ScriptPath>;
  /** Script of the active tab, shown as selected. */
  readonly activePath: ScriptPath | null;
  readonly onToggle: (folder: ScriptPath) => void;
  readonly onOpen: (script: ScriptPath) => void;
  /** `parent` is the folder to create in; `null` is the top level. */
  readonly onNewScript: (parent: ScriptPath | null) => void;
  readonly onNewFolder: (parent: ScriptPath | null) => void;
  readonly onRename: (entry: TreeEntry) => void;
  readonly onDelete: (entry: TreeEntry) => void;
  readonly onMove: (path: ScriptPath, folder: ScriptPath | null) => void;
}

/** An entry as one line of the tree. */
interface Row {
  readonly entry: TreeEntry;
  /** Depth, starting at 1 (the value of `aria-level`). */
  readonly level: number;
  /** Folder that contains it; `null` at the top level. */
  readonly parent: ScriptPath | null;
}

/** The entries on screen, top to bottom: contents follow their folder when it is expanded. */
function visibleRows(
  entries: readonly TreeEntry[],
  expanded: ReadonlySet<ScriptPath>,
  level = 1,
  parent: ScriptPath | null = null,
  rows: Row[] = [],
): Row[] {
  for (const entry of entries) {
    rows.push({ entry, level, parent });
    if (entry.kind === "folder" && expanded.has(entry.path)) {
      visibleRows(entry.children, expanded, level + 1, entry.path, rows);
    }
  }
  return rows;
}

/** Where something created or dropped "on" a row goes: into a folder, next to a script. */
function folderOf(row: Row | null): ScriptPath | null {
  if (row === null) return null;
  return row.entry.kind === "folder" ? row.entry.path : row.parent;
}

function entryTitle(entry: TreeEntry): string {
  return entry.kind === "script" ? scriptTitle(entry.name) : entry.name;
}

const MENU_ITEM =
  "flex h-7 cursor-default items-center px-3 outline-none select-none data-[highlighted]:bg-desk-raised";

/**
 * The scripts folder as a WAI-ARIA tree: arrow keys move, Enter opens, F2 renames and Delete
 * deletes; a context menu offers the same actions, and entries are moved by dragging them.
 */
export function ScriptTree({
  label,
  entries,
  expanded,
  activePath,
  onToggle,
  onOpen,
  onNewScript,
  onNewFolder,
  onRename,
  onDelete,
  onMove,
}: ScriptTreeProps) {
  const { t } = useTranslation();
  const rows = visibleRows(entries, expanded);
  const elements = useRef(new Map<ScriptPath, HTMLDivElement>());
  /** The row that keeps the tree's place in the tab order (roving tabindex). */
  const [current, setCurrent] = useState<ScriptPath | null>(null);
  /** What the context menu is about; `null` is the empty area. */
  const [menuRow, setMenuRow] = useState<Row | null>(null);
  const [dragged, setDragged] = useState<ScriptPath | null>(null);
  /** Folder a drop would go to (`null` is the top level); `undefined` when nothing is over. */
  const [dropFolder, setDropFolder] = useState<ScriptPath | null | undefined>(undefined);

  const tabStop = rows.find((row) => row.entry.path === current) ?? rows[0];
  const rowAt = (target: EventTarget): Row | null => {
    const path = (target as Element).closest("[data-path]")?.getAttribute("data-path");
    return rows.find((row) => row.entry.path === path) ?? null;
  };
  const focusRow = (row: Row | undefined) => {
    if (row !== undefined) elements.current.get(row.entry.path)?.focus();
  };

  const activate = ({ entry }: Row) => {
    if (entry.kind === "folder") onToggle(entry.path);
    else onOpen(entry.path);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    const row = rowAt(event.target);
    if (row === null) return;
    const index = rows.indexOf(row);
    const { entry } = row;
    const isOpenFolder = entry.kind === "folder" && expanded.has(entry.path);

    const keys: Partial<Record<string, () => void>> = {
      ArrowDown: () => {
        focusRow(rows[index + 1]);
      },
      ArrowUp: () => {
        focusRow(rows[index - 1]);
      },
      Home: () => {
        focusRow(rows[0]);
      },
      End: () => {
        focusRow(rows[rows.length - 1]);
      },
      ArrowRight: () => {
        if (entry.kind !== "folder") return;
        if (!isOpenFolder) onToggle(entry.path);
        else if (rows[index + 1]?.parent === entry.path) focusRow(rows[index + 1]);
      },
      ArrowLeft: () => {
        if (isOpenFolder) onToggle(entry.path);
        else focusRow(rows.find((candidate) => candidate.entry.path === row.parent));
      },
      Enter: () => {
        activate(row);
      },
      F2: () => {
        onRename(entry);
      },
      Delete: () => {
        onDelete(entry);
      },
    };
    const handle = keys[event.key];
    if (handle === undefined) return;
    event.preventDefault();
    handle();
  };

  /** Whether dropping the dragged entry into `folder` would move it somewhere else. */
  const canDropInto = (folder: ScriptPath | null): boolean => {
    if (dragged === null) return false;
    const row = rows.find((candidate) => candidate.entry.path === dragged);
    const alreadyThere = row?.parent === folder;
    const intoItself = folder !== null && (folder === dragged || folder.startsWith(`${dragged}/`));
    return !alreadyThere && !intoItself;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    const folder = folderOf(rowAt(event.target));
    if (!canDropInto(folder)) {
      setDropFolder(undefined);
      return;
    }
    // Without this the browser refuses the drop.
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropFolder(folder);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const folder = folderOf(rowAt(event.target));
    if (dragged !== null && canDropInto(folder)) onMove(dragged, folder);
    setDragged(null);
    setDropFolder(undefined);
  };

  const menuFolder = folderOf(menuRow);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>
        <div
          role="tree"
          aria-label={label}
          onKeyDown={onKeyDown}
          onContextMenu={(event) => {
            setMenuRow(rowAt(event.target));
          }}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onDragLeave={() => {
            setDropFolder(undefined);
          }}
          className={`min-h-8 flex-1 pb-2 ${dropFolder === null ? "bg-desk-raised" : ""}`}
        >
          {rows.map((row) => {
            const { entry, level } = row;
            const isFolder = entry.kind === "folder";
            const isOpen = isFolder && expanded.has(entry.path);
            return (
              <div
                key={entry.path}
                ref={(element) => {
                  if (element) elements.current.set(entry.path, element);
                  else elements.current.delete(entry.path);
                }}
                role="treeitem"
                aria-level={level}
                aria-expanded={isFolder ? isOpen : undefined}
                aria-selected={entry.path === activePath}
                tabIndex={row === tabStop ? 0 : -1}
                data-path={entry.path}
                draggable
                onFocus={() => {
                  setCurrent(entry.path);
                }}
                onClick={() => {
                  activate(row);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", entry.name);
                  setDragged(entry.path);
                }}
                onDragEnd={() => {
                  setDragged(null);
                  setDropFolder(undefined);
                }}
                style={{ paddingLeft: `${String(0.5 + (level - 1) * 0.875)}rem` }}
                className={`flex h-6 cursor-default items-center gap-1 pr-2 text-sm outline-none hover:bg-desk-raised focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset aria-selected:text-ink ${
                  entry.path === activePath ? "bg-desk-raised font-semibold" : "text-pencil"
                } ${isFolder && dropFolder === entry.path ? "ring-1 ring-accent ring-inset" : ""}`}
              >
                <Twisty>
                  {isFolder && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                </Twisty>
                {isFolder ? (
                  isOpen ? (
                    <FolderOpen aria-hidden size={13} className="shrink-0" />
                  ) : (
                    <Folder aria-hidden size={13} className="shrink-0" />
                  )
                ) : (
                  <FileCode aria-hidden size={13} className="shrink-0" />
                )}
                <span className="truncate">{entryTitle(entry)}</span>
              </div>
            );
          })}
        </div>
      </ContextMenu.Trigger>

      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-44 rounded border border-rule bg-paper py-1 text-sm text-ink shadow-lg">
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              onNewScript(menuFolder);
            }}
          >
            {t("explorer.scripts.newScript")}
          </ContextMenu.Item>
          <ContextMenu.Item
            className={MENU_ITEM}
            onSelect={() => {
              onNewFolder(menuFolder);
            }}
          >
            {t("explorer.scripts.newFolder")}
          </ContextMenu.Item>
          {menuRow !== null && (
            <>
              <ContextMenu.Separator className="my-1 h-px bg-rule" />
              <ContextMenu.Item
                className={MENU_ITEM}
                onSelect={() => {
                  onRename(menuRow.entry);
                }}
              >
                {t("explorer.scripts.rename")}
              </ContextMenu.Item>
              {menuRow.parent !== null && (
                <ContextMenu.Item
                  className={MENU_ITEM}
                  onSelect={() => {
                    onMove(menuRow.entry.path, null);
                  }}
                >
                  {t("explorer.scripts.moveToRoot")}
                </ContextMenu.Item>
              )}
              <ContextMenu.Item
                className={MENU_ITEM}
                onSelect={() => {
                  onDelete(menuRow.entry);
                }}
              >
                {t("explorer.scripts.delete")}
              </ContextMenu.Item>
            </>
          )}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The expand marker of a folder; scripts keep the space so names line up. */
function Twisty({ children }: { readonly children: ReactNode }) {
  return (
    <span aria-hidden className="flex w-3 shrink-0 justify-center">
      {children}
    </span>
  );
}
