import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Group,
  Panel,
  Separator,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { useStore } from "zustand";

import { ConflictBanner } from "../../features/editor/ConflictBanner";
import type { CursorPosition, EditorHandle } from "../../features/editor/editorModule";
import { EditorPane } from "../../features/editor/EditorPane";
import { EditorToolbar } from "../../features/editor/EditorToolbar";
import { ScriptTabs } from "../../features/editor/ScriptTabs";
import { SCRIPT_PANEL_ID, scriptTabId } from "../../features/editor/tabIds";
import { tabTitle } from "../../features/editor/tabTitle";
import { ExplorerSidebar } from "../../features/explorer/ExplorerSidebar";
import { ResultsPane } from "../../features/results/ResultsPane";
import type { ScriptPath, TreeEntry } from "../../shared/ipc";
import { DEFAULT_LANGUAGE, findLanguage } from "../../shared/languages";
import { Dialogs } from "../dialogs/Dialogs";
import { installKeybindings } from "../keybindings";
import { storedLayout } from "../layout";
import type { AppServices } from "../services";
import { MenuBar } from "./MenuBar";
import { Notices } from "./Notices";
import { StatusBar } from "./StatusBar";

/** Panel groups and their panels, as the preferences name them (design §5.5). */
const WORKSPACE_GROUP = "workspace";
const DOCUMENT_GROUP = "document";
const WORKSPACE_PANELS = ["explorer", "main"] as const;
const DOCUMENT_PANELS = ["editor", "results"] as const;

const SEPARATOR =
  "bg-rule outline-none data-[separator=hover]:bg-accent data-[separator=active]:bg-accent focus-visible:bg-accent";

/** Paths of every folder of the tree, for the "save as" folder picker. */
function folderPaths(entries: readonly TreeEntry[], paths: ScriptPath[] = []): ScriptPath[] {
  for (const entry of entries) {
    if (entry.kind === "folder") {
      paths.push(entry.path);
      folderPaths(entry.children, paths);
    }
  }
  return paths;
}

/**
 * Main window layout (spec section 3.1): explorer beside the open scripts, editor above the
 * results. It renders the stores and hands every user action to `actions`.
 */
export function AppShell({ services }: { readonly services: AppServices }) {
  const { session, ui, actions } = services;
  const { workspace } = session;
  const { t } = useTranslation();

  const tabs = useStore(workspace.store, (state) => state.tabs);
  const activeId = useStore(workspace.store, (state) => state.activeId);
  const journalFailed = useStore(workspace.store, (state) => state.journalFailed);
  const explorer = useStore(session.explorer.store);
  const dialog = useStore(ui, (state) => state.dialog);
  const notice = useStore(ui, (state) => state.notice);
  const cursor = useStore(ui, (state) => state.cursor);

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  // With no script open the pickers are disabled and show the language a new script would get.
  const language = findLanguage(active?.header.language ?? DEFAULT_LANGUAGE);
  const mode = active?.header.mode ?? language.modes[0];

  const editor = useRef<EditorHandle | null>(null);
  const onEditorReady = useCallback((handle: EditorHandle | null) => {
    editor.current = handle;
  }, []);
  const onCursorChange = useCallback(
    (position: CursorPosition) => {
      ui.setState({ cursor: position });
    },
    [ui],
  );
  const focusEditor = () => {
    editor.current?.focus();
  };
  const newScript = () => {
    actions.newScript();
    focusEditor();
  };

  useEffect(() => {
    const { store } = workspace;
    // Shortcuts act on the window behind a dialog, so they wait until it is answered.
    const unlessInDialog = (run: () => void) => () => {
      if (ui.getState().dialog === null) run();
    };
    const withActiveTab = (run: (id: string) => Promise<void>) => () => {
      const id = store.getState().activeId;
      if (id !== null) void run(id);
    };
    return installKeybindings(
      window,
      {
        "script.new": unlessInDialog(() => {
          actions.newScript();
          editor.current?.focus();
        }),
        "script.save": unlessInDialog(withActiveTab(actions.save)),
        "tab.close": unlessInDialog(withActiveTab(actions.closeTab)),
      },
      () => session.preferences().keybindings,
    );
  }, [workspace, session, ui, actions]);

  const [layouts] = useState(() => {
    const { layout } = session.preferences();
    return {
      workspace: storedLayout(layout[WORKSPACE_GROUP], WORKSPACE_PANELS),
      document: storedLayout(layout[DOCUMENT_GROUP], DOCUMENT_PANELS),
    };
  });
  const saveLayout =
    (group: "workspace" | "document") => (layout: Layout, meta: LayoutChangedMeta) => {
      // Only what the user dragged: sizes the library settles on by itself are not a choice.
      if (!meta.isUserInteraction) return;
      session.updatePreferences((preferences) => ({
        ...preferences,
        layout: { ...preferences.layout, [group]: layout },
      }));
    };

  return (
    <div data-language={language.id} className="flex h-full flex-col">
      <MenuBar />
      <Notices
        notice={notice}
        onDismissNotice={actions.dismissNotice}
        recoveryUnavailable={!session.notices.recoveryAvailable || journalFailed}
      />
      <Group
        id="workspace"
        orientation="horizontal"
        defaultLayout={layouts.workspace}
        onLayoutChanged={saveLayout("workspace")}
        className="min-h-0 flex-1"
      >
        <Panel id="explorer" defaultSize="18%" minSize="10%" collapsible collapsedSize="0%">
          <ExplorerSidebar
            explorer={explorer}
            activePath={active?.path ?? null}
            onToggle={(folder) => {
              session.explorer.toggle(folder);
            }}
            onOpen={(path) => {
              void actions.openScript(path).then(focusEditor);
            }}
            onNewScript={actions.promptNewScript}
            onNewFolder={actions.promptNewFolder}
            onRename={actions.promptRename}
            onDelete={actions.promptDelete}
            onMove={(path, folder) => {
              void actions.move(path, folder);
            }}
            onMoveTo={actions.promptMove}
            onChooseFolder={() => {
              void actions.chooseScriptsFolder(t("explorer.scripts.chooseFolderTitle"));
            }}
          />
        </Panel>
        <Separator className={`w-px ${SEPARATOR}`} />
        <Panel id="main" minSize="40%">
          <main className="flex h-full min-h-0 min-w-0 flex-col">
            <ScriptTabs
              tabs={tabs}
              activeId={activeId}
              onActivate={(id, byPointer) => {
                workspace.activate(id);
                if (byPointer) focusEditor();
              }}
              onClose={(id) => {
                void actions.closeTab(id);
              }}
              onNew={newScript}
            />
            <div
              role="tabpanel"
              id={SCRIPT_PANEL_ID}
              aria-labelledby={active === null ? undefined : scriptTabId(active.id)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <EditorToolbar
                language={language}
                mode={mode}
                disabled={active === null}
                onLanguageChange={(next) => {
                  if (active !== null) workspace.setLanguage(active.id, next);
                }}
                onModeChange={(next) => {
                  if (active !== null) workspace.setMode(active.id, next);
                }}
              />
              {active !== null && active.disk !== "same" && (
                <ConflictBanner
                  disk={active.disk}
                  onReload={() => {
                    void actions.reloadFromDisk(active.id);
                  }}
                  onKeepMine={() => {
                    workspace.keepMine(active.id);
                  }}
                  onSave={() => {
                    void actions.save(active.id);
                  }}
                />
              )}
              <Group
                id="document"
                orientation="vertical"
                defaultLayout={layouts.document}
                onLayoutChanged={saveLayout("document")}
                className="min-h-0 flex-1"
              >
                <Panel id="editor" defaultSize="60%" minSize="20%">
                  <EditorPane
                    editor={session.editor}
                    buffers={session.buffers}
                    activeId={activeId}
                    onCursorChange={onCursorChange}
                    onReady={onEditorReady}
                    onNewScript={newScript}
                  />
                </Panel>
                <Separator className={`h-px ${SEPARATOR}`} />
                <Panel id="results" defaultSize="40%" minSize="15%" collapsible collapsedSize="0%">
                  <ResultsPane />
                </Panel>
              </Group>
            </div>
          </main>
        </Panel>
      </Group>
      <StatusBar
        script={active === null ? null : { language, mode, cursor, newline: active.newline }}
      />
      <Dialogs
        dialog={dialog}
        tabTitle={(id) => {
          const tab = tabs.find((candidate) => candidate.id === id);
          return tab === undefined ? "" : tabTitle(tab, t);
        }}
        folders={explorer.tree === null ? [] : folderPaths(explorer.tree.entries)}
        actions={actions}
      />
    </div>
  );
}
