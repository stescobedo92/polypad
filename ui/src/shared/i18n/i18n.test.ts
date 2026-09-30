import { describe, expect, it } from "vitest";

import { detectLocale, resources } from "./index";

function keysOf(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    keysOf(child, prefix === "" ? key : `${prefix}.${key}`),
  );
}

describe("translations", () => {
  it("define exactly the same keys in every locale", () => {
    const english = keysOf(resources.en.translation).sort();
    const spanish = keysOf(resources.es.translation).sort();

    expect(spanish).toEqual(english);
  });

  it("keep the same interpolation placeholders across locales", () => {
    const placeholders = (text: string) => [...text.matchAll(/{{(\w+)}}/g)].map((m) => m[1]);
    const english = new Map(
      keysOf(resources.en.translation).map((key) => [key, lookup(resources.en.translation, key)]),
    );

    for (const key of keysOf(resources.es.translation)) {
      expect(placeholders(lookup(resources.es.translation, key)), key).toEqual(
        placeholders(english.get(key) ?? ""),
      );
    }
  });
});

describe("detectLocale", () => {
  it("matches on the base language of a regional tag", () => {
    expect(detectLocale(["es-MX", "en-US"])).toBe("es");
  });

  it("uses the first supported entry in preference order", () => {
    expect(detectLocale(["fr-FR", "en-GB", "es-ES"])).toBe("en");
  });

  it("falls back to English when nothing is supported", () => {
    expect(detectLocale(["de-DE"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });
});

function lookup(tree: object, path: string): string {
  const value = path
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[key]
          : undefined,
      tree,
    );
  return typeof value === "string" ? value : "";
}
