import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Language } from "../../shared/languages";
import { IconButton } from "../../shared/ui/IconButton";
import { LanguageSwatch } from "../../shared/ui/LanguageSwatch";

export const SCRIPT_PANEL_ID = "script-panel";

interface ScriptTabsProps {
  readonly language: Language;
}

/** Open scripts. Phase 0 shows a single untitled script; documents arrive in Phase 1. */
export function ScriptTabs({ language }: ScriptTabsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex h-8 shrink-0 items-stretch border-b border-rule bg-desk">
      <div role="tablist" aria-label={t("tabs.label")} className="flex items-stretch">
        <div
          role="tab"
          id="script-tab-1"
          aria-selected="true"
          aria-controls={SCRIPT_PANEL_ID}
          tabIndex={0}
          className="relative -mb-px flex items-center gap-2 border-r border-rule bg-paper px-3 text-sm before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-accent"
        >
          <LanguageSwatch language={language.id} />
          {t("tabs.untitled", { index: 1 })}
        </div>
      </div>
      <div className="flex items-center px-1.5">
        <IconButton label={t("tabs.new")} icon={Plus} disabled />
      </div>
    </div>
  );
}
