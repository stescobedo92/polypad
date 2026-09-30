import { useTranslation } from "react-i18next";

import { PolyPadMark } from "./PolyPadMark";

const MENUS = ["file", "edit", "query", "view", "tools", "help"] as const;

/**
 * Application menu row. Menus open in Phase 1; until then the entries stay focusable (so they
 * can be discovered) but are marked and styled as unavailable.
 */
export function MenuBar() {
  const { t } = useTranslation();

  return (
    <header className="flex h-8 items-center gap-2 border-b border-rule bg-desk px-2.5">
      <PolyPadMark />
      <nav aria-label={t("menu.label")} className="flex">
        {MENUS.map((menu) => (
          <button
            key={menu}
            type="button"
            aria-disabled="true"
            title={t("common.notAvailableYet")}
            className="cursor-default rounded px-2 py-0.5 text-sm text-pencil opacity-40"
          >
            {t(`menu.${menu}`)}
          </button>
        ))}
      </nav>
    </header>
  );
}
