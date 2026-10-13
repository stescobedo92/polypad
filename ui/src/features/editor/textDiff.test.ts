import { describe, expect, it } from "vitest";

import { changedSpan } from "./textDiff";

/** Applies a span the way an editor applies an edit. */
function apply(before: string, after: string): string {
  const span = changedSpan(before, after);
  if (span === null) return before;
  return before.slice(0, span.start) + span.text + before.slice(span.end);
}

describe("changedSpan", () => {
  it("is null when nothing changed", () => {
    expect(changedSpan("same", "same")).toBeNull();
    expect(changedSpan("", "")).toBeNull();
  });

  it("covers only what differs between the common start and the common end", () => {
    expect(changedSpan("let a = 1;\nlet b = 2;", "let a = 1;\nlet b = 3;")).toEqual({
      start: 19,
      end: 20,
      text: "3",
    });
    expect(changedSpan("abc", "abXYc")).toEqual({ start: 2, end: 2, text: "XY" });
    expect(changedSpan("abXYc", "abc")).toEqual({ start: 2, end: 4, text: "" });
  });

  it("replaces everything when nothing is shared", () => {
    expect(changedSpan("old", "new")).toEqual({ start: 0, end: 3, text: "new" });
    expect(changedSpan("", "text")).toEqual({ start: 0, end: 0, text: "text" });
    expect(changedSpan("text", "")).toEqual({ start: 0, end: 4, text: "" });
  });

  it("does not count the same characters twice when the change repeats its surroundings", () => {
    expect(apply("aaa", "aaaa")).toBe("aaaa");
    expect(apply("abab", "ab")).toBe("ab");
    expect(changedSpan("aaa", "aaaa")).toEqual({ start: 3, end: 3, text: "a" });
  });

  it("never splits a character made of two UTF-16 units", () => {
    // Both emoji start with the same high surrogate and differ in the low one.
    const before = "x 😀 y";
    const after = "x 😁 y";
    const span = changedSpan(before, after);

    expect(span).toEqual({ start: 2, end: 4, text: "😁" });
    expect(apply(before, after)).toBe(after);
  });

  it("gives back the new text in every case", () => {
    const cases: [string, string][] = [
      ["", "a"],
      ["a\r\nb", "a\nb"],
      ["😀😀", "😀"],
      ["one two three", "one 2 three"],
      ["tail", "tail tail"],
    ];
    for (const [before, after] of cases) {
      expect(apply(before, after)).toBe(after);
    }
  });
});
