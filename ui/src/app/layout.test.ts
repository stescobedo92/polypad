import { describe, expect, it } from "vitest";

import { storedLayout } from "./layout";

describe("a stored panel layout", () => {
  const panels = ["explorer", "main"] as const;

  it("is used when it sizes exactly the panels of the group", () => {
    expect(storedLayout({ explorer: 18, main: 82 }, panels)).toEqual({ explorer: 18, main: 82 });
    expect(storedLayout({ explorer: 0, main: 100 }, panels)).toEqual({ explorer: 0, main: 100 });
  });

  it("is ignored when a panel is missing, unknown or has no size", () => {
    expect(storedLayout(undefined, panels)).toBeUndefined();
    expect(storedLayout({ explorer: 18 }, panels)).toBeUndefined();
    expect(storedLayout({ explorer: 18, main: null }, panels)).toBeUndefined();
    expect(storedLayout({ explorer: 18, main: 72, results: 10 }, panels)).toBeUndefined();
  });

  it("is ignored when the sizes are not percentages that add up to the whole", () => {
    expect(storedLayout({ explorer: -5, main: 105 }, panels)).toBeUndefined();
    expect(storedLayout({ explorer: 30, main: 30 }, panels)).toBeUndefined();
    expect(storedLayout({ explorer: Number.NaN, main: 100 }, panels)).toBeUndefined();
  });
});
