/** Panel sizes kept in the preferences (docs/adr/0007), checked before the panels use them. */
import type { Layout } from "react-resizable-panels";

/** How far the sizes of a group may be from 100 % and still count as a whole. */
const TOLERANCE = 0.5;

/**
 * The saved sizes of a panel group, or `undefined` (use the defaults) unless they size exactly
 * `panels` with percentages that add up to the whole: the file can be edited by hand, and a
 * layout from a build with other panels must not be applied.
 */
export function storedLayout(
  stored: Readonly<Record<string, number | null>> | undefined,
  panels: readonly string[],
): Layout | undefined {
  if (stored === undefined || Object.keys(stored).length !== panels.length) return undefined;
  const layout: Layout = {};
  let total = 0;
  for (const panel of panels) {
    const size = stored[panel];
    if (typeof size !== "number" || !Number.isFinite(size) || size < 0 || size > 100) {
      return undefined;
    }
    layout[panel] = size;
    total += size;
  }
  return Math.abs(total - 100) <= TOLERANCE ? layout : undefined;
}
