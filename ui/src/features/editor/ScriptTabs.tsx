import { Plus, TriangleAlert, X } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { BufferId } from "../../shared/ipc";
import { IconButton } from "../../shared/ui/IconButton";
import { LanguageSwatch } from "../../shared/ui/LanguageSwatch";
import type { Tab } from "../workspace/workspace";
import { SCRIPT_PANEL_ID, scriptTabId } from "./tabIds";
import { tabLabel, tabTitle } from "./tabTitle";

interface ScriptTabsProps {
  readonly tabs: readonly Tab[];
  readonly activeId: BufferId | null;
  /** `byPointer` tells a click from keyboard navigation, which keeps the focus on the tabs. */
  readonly onActivate: (id: BufferId, byPointer: boolean) => void;
  readonly onClose: (id: BufferId) => void;
  readonly onNew: () => void;
}

/**
 * Open scripts as WAI-ARIA tabs: arrow keys move between them and Delete closes the focused one.
 * A dot marks unsaved changes; a script deleted on disk is struck through and one that changed
 * on disk carries a warning sign.
 */
export function ScriptTabs({ tabs, activeId, onActivate, onClose, onNew }: ScriptTabsProps) {
  const { t } = useTranslation();
  const buttons = useRef(new Map<BufferId, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Delete" && activeId !== null) {
      event.preventDefault();
      onClose(activeId);
      return;
    }
    const current = tabs.findIndex((tab) => tab.id === activeId);
    const moves: Partial<Record<string, number>> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined || tabs.length === 0) return;
    event.preventDefault();
    const next = tabs[((target % tabs.length) + tabs.length) % tabs.length];
    if (next === undefined) return;
    onActivate(next.id, false);
    buttons.current.get(next.id)?.focus();
  };

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-rule bg-desk">
      <div
        role="tablist"
        aria-label={t("tabs.label")}
        onKeyDown={onKeyDown}
        className="flex min-w-0 items-stretch overflow-x-auto overflow-y-hidden"
      >
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          const title = tabTitle(tab, t);
          const label = tabLabel(tab, t);
          const close = t("tabs.close", { title });
          return (
            <div
              key={tab.id}
              role="presentation"
              className={`relative -mb-px flex shrink-0 items-stretch border-r border-rule text-sm ${
                selected
                  ? "bg-paper text-ink before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent"
                  : "text-pencil hover:text-ink"
              }`}
            >
              <button
                ref={(element) => {
                  if (element) buttons.current.set(tab.id, element);
                  else buttons.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={scriptTabId(tab.id)}
                aria-label={label}
                aria-selected={selected}
                aria-controls={SCRIPT_PANEL_ID}
                tabIndex={selected ? 0 : -1}
                title={label}
                onClick={() => {
                  onActivate(tab.id, true);
                }}
                onAuxClick={(event) => {
                  // The middle button closes, as in browsers and editors.
                  if (event.button === 1) onClose(tab.id);
                }}
                className="flex items-center gap-2 pr-1 pl-3"
              >
                <LanguageSwatch language={tab.header.language} />
                <span className={tab.disk === "missing" ? "line-through" : undefined}>{title}</span>
                {tab.disk === "changed" && (
                  <TriangleAlert aria-hidden size={12} className="text-danger" />
                )}
                <span aria-hidden className="w-2 text-center text-xs">
                  {tab.modified ? "●" : ""}
                </span>
              </button>
              <button
                type="button"
                aria-label={close}
                title={close}
                tabIndex={-1}
                onClick={() => {
                  onClose(tab.id);
                }}
                className="mr-1 inline-flex size-5 items-center justify-center self-center rounded text-pencil hover:bg-desk-raised hover:text-ink"
              >
                <X aria-hidden size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center px-1.5">
        <IconButton label={t("tabs.new")} icon={Plus} onClick={onNew} />
      </div>
    </div>
  );
}
