/**
 * Makes third-party code compatible with Tauri's `freezePrototype` (docs/adr/0008).
 *
 * With `Object.prototype` frozen, `target.toString = fn` throws in strict mode when `target` is a
 * plain object: the inherited `toString` is read-only, and JavaScript refuses to shadow a
 * read-only inherited property by assignment (the "override mistake"). Compiled TypeScript
 * namespaces in Monaco do exactly that. `Object.defineProperty` creates the same own property
 * without consulting the prototype, so those statements are rewritten at build time.
 *
 * The build fails when the set of rewritten statements differs from the expected one, so a
 * dependency upgrade that adds or removes such a statement is reviewed instead of breaking the
 * editor at runtime.
 */
import type { Plugin } from "vite";

/** Members of `Object.prototype` that cannot be assigned on plain objects once it is frozen. */
const SHADOWED_MEMBERS = [
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
];

const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;

/** A whole-line `Target.member = identifier;` statement. */
const ASSIGNMENT = new RegExp(
  String.raw`^([ \t]*)(${IDENTIFIER})\.(${SHADOWED_MEMBERS.join("|")}) = (${IDENTIFIER});[ \t]*$`,
  "gm",
);

export interface Rewrite {
  /** The code with every matching statement rewritten. */
  readonly code: string;
  /** `Target.member` of each rewritten statement, in source order. */
  readonly patched: readonly string[];
}

/** Rewrites `Target.member = value;` statements as equivalent `Object.defineProperty` calls. */
export function rewriteShadowingAssignments(code: string): Rewrite {
  const patched: string[] = [];
  const rewritten = code.replace(
    ASSIGNMENT,
    (_statement, indent: string, target: string, member: string, value: string) => {
      patched.push(`${target}.${member}`);
      // Same property as the assignment would create: own, writable, enumerable, configurable.
      return `${indent}Object.defineProperty(${target}, "${member}", { value: ${value}, writable: true, enumerable: true, configurable: true });`;
    },
  );
  return { code: rewritten, patched };
}

/** Describes how `found` differs from `expected`, or returns `null` when they match. */
export function checkPatched(
  found: ReadonlySet<string>,
  expected: readonly string[],
): string | null {
  const unexpected = [...found].filter((entry) => !expected.includes(entry)).sort();
  const missing = expected.filter((entry) => !found.has(entry)).sort();
  if (unexpected.length === 0 && missing.length === 0) {
    return null;
  }
  return [
    "The statements rewritten for freezePrototype changed (see build/frozenPrototypeCompat.ts).",
    unexpected.length > 0 ? `New: ${unexpected.join(", ")}.` : "",
    missing.length > 0 ? `No longer found: ${missing.join(", ")}.` : "",
    "Check each one and update the expected list in vite.config.ts.",
  ]
    .filter(Boolean)
    .join(" ");
}

export interface FrozenPrototypeCompatOptions {
  /** Modules to rewrite (matched against their resolved id). */
  readonly include: RegExp;
  /** Every `Target.member` the build is expected to rewrite. */
  readonly expected: readonly string[];
}

/**
 * The same rewrite for Vite's dependency pre-bundling, which the development server uses and
 * which does not run regular plugins (register it in `optimizeDeps.rolldownOptions.plugins`).
 */
export function frozenPrototypeCompatForDependencies(
  options: Pick<FrozenPrototypeCompatOptions, "include">,
): Plugin {
  return {
    name: "polypad:frozen-prototype-compat-deps",
    transform(code, id) {
      if (!options.include.test(id)) {
        return null;
      }
      const rewrite = rewriteShadowingAssignments(code);
      return rewrite.patched.length === 0 ? null : { code: rewrite.code, map: null };
    },
  };
}

/** Vite plugin applying {@link rewriteShadowingAssignments} to `include`d modules. */
export function frozenPrototypeCompat(options: FrozenPrototypeCompatOptions): Plugin {
  const found = new Set<string>();
  return {
    name: "polypad:frozen-prototype-compat",
    transform(code, id) {
      if (!options.include.test(id)) {
        return null;
      }
      const rewrite = rewriteShadowingAssignments(code);
      if (rewrite.patched.length === 0) {
        return null;
      }
      rewrite.patched.forEach((entry) => found.add(entry));
      return { code: rewrite.code, map: null };
    },
    buildEnd(error) {
      // Only a complete production build sees every module; the dev server transforms lazily.
      if (error !== undefined || this.meta.watchMode) {
        return;
      }
      const problem = checkPatched(found, options.expected);
      if (problem !== null) {
        this.error(problem);
      }
    },
  };
}
