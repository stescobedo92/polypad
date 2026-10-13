import type { BufferId } from "../../shared/ipc";

/** Id of the panel every script tab controls: the toolbar, the editor and the results. */
export const SCRIPT_PANEL_ID = "script-panel";

/** Id of the tab element of a buffer, which labels that panel. */
export function scriptTabId(id: BufferId): string {
  return `script-tab-${id}`;
}
