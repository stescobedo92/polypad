import { useState } from "react";
import { useTranslation } from "react-i18next";

import { TabList } from "../../shared/ui/TabList";

const RESULT_TABS = ["results", "sql", "ir", "tree", "log"] as const;
type ResultTab = (typeof RESULT_TABS)[number];

const ID_PREFIX = "results";

/** Output of the last run: dumps, generated SQL, IR, syntax tree and log. */
export function ResultsPane() {
  const { t } = useTranslation();
  const [active, setActive] = useState<ResultTab>("results");

  return (
    <section aria-label={t("results.label")} className="flex h-full min-h-0 flex-col bg-paper">
      <TabList
        label={t("results.label")}
        tabs={RESULT_TABS}
        active={active}
        onSelect={setActive}
        renderTab={(tab) => t(`results.tabs.${tab}`)}
        idPrefix={ID_PREFIX}
      />
      <div
        role="tabpanel"
        id={`${ID_PREFIX}-panel`}
        aria-labelledby={`${ID_PREFIX}-tab-${active}`}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto px-3 py-2.5 text-sm text-pencil select-text"
      >
        <p>{t(`results.empty.${active}`)}</p>
      </div>
    </section>
  );
}
