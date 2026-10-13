import type { TFunction } from "i18next";

import { fileNameOf, scriptTitle } from "../../shared/scripts";
import type { Tab } from "../workspace/workspace";

/** Name of a tab as shown on it and in messages about it. */
export function tabTitle(tab: Tab, t: TFunction): string {
  if (tab.path !== null) {
    return scriptTitle(fileNameOf(tab.path));
  }
  // Work recovered from a scripts folder that is not open now: named after the script it was.
  if (tab.previousPath !== null) {
    return t("tabs.recovered", { name: scriptTitle(fileNameOf(tab.previousPath)) });
  }
  return t("tabs.untitled", { index: tab.untitledNumber ?? 1 });
}

/** The title followed by what is special about the tab, for assistive technology and tooltips. */
export function tabLabel(tab: Tab, t: TFunction): string {
  const states: string[] = [];
  if (tab.modified) states.push(t("tabs.state.modified"));
  if (tab.disk === "changed") states.push(t("tabs.state.changed"));
  if (tab.disk === "missing") states.push(t("tabs.state.missing"));
  return [tabTitle(tab, t), ...states].join(", ");
}
