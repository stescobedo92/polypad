import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it, vi } from "vitest";

import { events } from "./bindings";
import {
  CommandFailure,
  onScriptsChanged,
  openScript,
  saveScript,
  type Document,
  type LoadedScript,
  type ScriptChanges,
} from "./index";

/** The rejection of `call`, which must be a CommandFailure. */
async function failureOf(call: Promise<unknown>): Promise<CommandFailure> {
  const failure = await call.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CommandFailure);
  return failure as CommandFailure;
}

const DOCUMENT: Document = {
  header: {
    language: "python",
    mode: "script",
    connection: null,
    packages: [],
    imports: [],
    extra: "{}",
  },
  code: "print(1)\n",
  newline: "lf",
};

describe("command wrappers", () => {
  it("return the data of a command that succeeds, sending its arguments", async () => {
    const loaded: LoadedScript = { document: DOCUMENT, normalized: false, stamp: "abc" };
    const calls: unknown[] = [];
    mockIPC((command, args) => {
      calls.push([command, args]);
      return loaded;
    });

    await expect(openScript("reports/a.ppad")).resolves.toEqual(loaded);
    expect(calls).toEqual([["open_script", { path: "reports/a.ppad" }]]);
  });

  it("raise the typed error a command returns", async () => {
    mockIPC(() => {
      // Tauri rejects with the serialized error object, not an Error instance.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw { code: "conflict", path: "a.ppad", current: "def" };
    });

    const failure = await failureOf(saveScript("a.ppad", DOCUMENT, "abc"));

    expect(failure.error).toEqual({
      code: "conflict",
      path: "a.ppad",
      current: "def",
    });
  });

  it("treat a rejection that is not a command error as internal", async () => {
    mockIPC(() => {
      // What Tauri sends when the ACL denies a command.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "Command open_script not allowed by ACL";
    });

    const failure = await failureOf(openScript("a.ppad"));

    expect(failure.error.code).toBe("internal");
  });

  it("treat a broken transport as internal and keep the cause", async () => {
    const cause = new TypeError("IPC unavailable");
    mockIPC(() => {
      throw cause;
    });

    const failure = await failureOf(openScript("a.ppad"));

    expect(failure.error.code).toBe("internal");
    expect(failure.cause).toBe(cause);
  });
});

describe("event subscriptions", () => {
  it("deliver the payload of ScriptsChanged until unsubscribed", async () => {
    mockIPC(() => undefined, { shouldMockEvents: true });
    const received = vi.fn();
    const changes: ScriptChanges = { paths: ["a.ppad"], renamed: [], rescan: false };

    const unsubscribe = await onScriptsChanged(received);
    await events.scriptsChanged.emit(changes);
    unsubscribe();
    await events.scriptsChanged.emit({ ...changes, rescan: true });

    expect(received).toHaveBeenCalledExactlyOnceWith(changes);
  });
});
