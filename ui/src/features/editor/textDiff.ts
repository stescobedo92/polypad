/** The part of a text to replace to turn it into another: `[start, end)` becomes `text`. */
export interface TextSpan {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The smallest span of `before` (in UTF-16 units, as editors count) that differs from `after`,
 * found by trimming what both texts start and end with; `null` when they are equal. Replacing
 * only that span leaves the cursor and folding of an editor alone wherever nothing changed.
 */
export function changedSpan(before: string, after: string): TextSpan | null {
  if (before === after) return null;
  const shorter = Math.min(before.length, after.length);

  let start = 0;
  while (start < shorter && before.charCodeAt(start) === after.charCodeAt(start)) {
    start += 1;
  }
  // The common end stops where the common start ends, so "aaa" to "aaaa" counts no "a" twice.
  let suffix = 0;
  while (
    suffix < shorter - start &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  // A span edge must not fall between the two halves of a character.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) {
    start -= 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) {
    suffix -= 1;
  }

  return {
    start,
    end: before.length - suffix,
    text: after.slice(start, after.length - suffix),
  };
}
