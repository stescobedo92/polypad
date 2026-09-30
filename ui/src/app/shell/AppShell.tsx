import { useState } from "react";

import { EditorPane } from "../../features/editor/EditorPane";
import { EditorToolbar } from "../../features/editor/EditorToolbar";
import { SCRIPT_PANEL_ID, ScriptTabs } from "../../features/editor/ScriptTabs";
import { ExplorerSidebar } from "../../features/explorer/ExplorerSidebar";
import { ResultsPane } from "../../features/results/ResultsPane";
import {
  DEFAULT_LANGUAGE,
  findLanguage,
  type ExecutionMode,
  type LanguageId,
} from "../../shared/languages";
import { MenuBar } from "./MenuBar";
import { StatusBar } from "./StatusBar";

/**
 * Main window layout (spec section 3.1). Regions are fixed in Phase 0; resizable, persisted
 * panels arrive in Phase 1.
 */
export function AppShell() {
  const [languageId, setLanguageId] = useState<LanguageId>(DEFAULT_LANGUAGE);
  const language = findLanguage(languageId);
  const [mode, setMode] = useState<ExecutionMode>(language.modes[0]);

  const changeLanguage = (next: LanguageId) => {
    setLanguageId(next);
    setMode(findLanguage(next).modes[0]);
  };

  return (
    <div data-language={languageId} className="grid h-full grid-rows-[auto_1fr_auto]">
      <MenuBar />
      <div className="grid min-h-0 grid-cols-[15rem_1fr]">
        <ExplorerSidebar />
        <main className="flex min-h-0 min-w-0 flex-col border-l border-rule">
          <ScriptTabs language={language} />
          <div
            role="tabpanel"
            id={SCRIPT_PANEL_ID}
            aria-labelledby="script-tab-1"
            className="flex min-h-0 flex-1 flex-col"
          >
            <EditorToolbar
              language={language}
              mode={mode}
              onLanguageChange={changeLanguage}
              onModeChange={setMode}
            />
            <div className="grid min-h-0 flex-1 grid-rows-[3fr_2fr]">
              <EditorPane language={language} />
              <ResultsPane />
            </div>
          </div>
        </main>
      </div>
      <StatusBar language={language} mode={mode} />
    </div>
  );
}
