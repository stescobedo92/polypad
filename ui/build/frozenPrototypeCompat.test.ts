import { describe, expect, it } from "vitest";

import { checkPatched, rewriteShadowingAssignments } from "./frozenPrototypeCompat";

/** Runs `statement` in strict mode with `ns` and `toString` in scope. */
function run(statement: string, ns: object, value: () => string) {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- executes the rewritten fixture
  const body = new Function("ns", "toString", `"use strict";\n${statement}`) as (
    ns: object,
    value: () => string,
  ) => void;
  body(ns, value);
}

describe("rewriteShadowingAssignments", () => {
  it("rewrites namespace members that shadow Object.prototype and reports them", () => {
    const source = [
      "var KeyCodeUtils;",
      "(function (KeyCodeUtils) {",
      "    KeyCodeUtils.toString = toString;",
      "    KeyCodeUtils.fromString = fromString;",
      "})(KeyCodeUtils || (KeyCodeUtils = {}));",
    ].join("\n");

    const result = rewriteShadowingAssignments(source);

    expect(result.patched).toEqual(["KeyCodeUtils.toString"]);
    expect(result.code).toContain(
      '    Object.defineProperty(KeyCodeUtils, "toString", { value: toString, writable: true, enumerable: true, configurable: true });',
    );
    expect(result.code).toContain("    KeyCodeUtils.fromString = fromString;");
  });

  it("leaves calls, other members and non-identifier values alone", () => {
    const source = [
      "const text = value.toString();",
      "id.toString = () => serviceId;",
      "options.valueOf = compute(1);",
      'log("a.toString = b;");',
    ].join("\n");

    const result = rewriteShadowingAssignments(source);

    expect(result.patched).toEqual([]);
    expect(result.code).toBe(source);
  });

  it("makes the assignment work when the prototype is frozen", () => {
    const frozenPrototype = Object.freeze({
      toString() {
        return "inherited";
      },
    });
    const own = () => "own";
    const statement = "ns.toString = toString;";

    expect(() => {
      run(statement, Object.create(frozenPrototype) as object, own);
    }).toThrow(TypeError);

    const namespace = Object.create(frozenPrototype) as { toString: () => string };
    run(rewriteShadowingAssignments(statement).code, namespace, own);
    expect(namespace.toString()).toBe("own");
    expect(Object.keys(namespace)).toEqual(["toString"]);
  });
});

describe("checkPatched", () => {
  it("accepts exactly the expected patches, in any order", () => {
    expect(checkPatched(new Set(["B.toString", "A.toString"]), ["A.toString", "B.toString"])).toBe(
      null,
    );
  });

  it("explains what appeared and what vanished", () => {
    const message = checkPatched(new Set(["A.toString", "C.valueOf"]), [
      "A.toString",
      "B.toString",
    ]);

    expect(message).toContain("C.valueOf");
    expect(message).toContain("B.toString");
  });
});
