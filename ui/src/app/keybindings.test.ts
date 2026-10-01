import { afterEach, describe, expect, it, vi } from "vitest";

import { chordOf, installKeybindings, normalizeChord, type CommandId } from "./keybindings";

function press(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function commands() {
  return {
    "script.new": vi.fn(),
    "script.save": vi.fn(),
    "tab.close": vi.fn(),
  } satisfies Record<CommandId, () => void>;
}

const uninstall: (() => void)[] = [];

afterEach(() => {
  uninstall.splice(0).forEach((remove) => {
    remove();
  });
  document.body.replaceChildren();
});

describe("chords", () => {
  it("name the modifiers in a fixed order and the key in upper case", () => {
    expect(chordOf(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }))).toBe("Ctrl+S");
    expect(chordOf(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+P",
    );
    expect(chordOf(new KeyboardEvent("keydown", { key: "F5", shiftKey: true }))).toBe("Shift+F5");
    expect(chordOf(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBeNull();
  });

  it("are compared regardless of how a preference spells them", () => {
    expect(normalizeChord("shift+ctrl+p")).toBe("Ctrl+Shift+P");
    expect(normalizeChord(" Ctrl + s ")).toBe("Ctrl+S");
  });
});

describe("installed key bindings", () => {
  it("run the command and keep the event from the editor and the browser", () => {
    const run = commands();
    uninstall.push(installKeybindings(window, run, () => ({})));
    // Monaco types into a textarea; shortcuts must work from there too.
    const textarea = document.body.appendChild(document.createElement("textarea"));
    const seenByPage = vi.fn();
    textarea.addEventListener("keydown", seenByPage);

    const event = press({ key: "s", ctrlKey: true }, textarea);

    expect(run["script.save"]).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(seenByPage).not.toHaveBeenCalled();
  });

  it("leave other keys alone", () => {
    const run = commands();
    uninstall.push(installKeybindings(window, run, () => ({})));

    const event = press({ key: "a", ctrlKey: true });

    expect(event.defaultPrevented).toBe(false);
    expect(Object.values(run).every((command) => command.mock.calls.length === 0)).toBe(true);
  });

  it("follow overrides from the preferences: a new chord, or none", () => {
    const run = commands();
    uninstall.push(
      installKeybindings(window, run, () => ({ "script.save": "ctrl+shift+s", "tab.close": null })),
    );

    press({ key: "s", ctrlKey: true });
    press({ key: "w", ctrlKey: true });
    expect(run["script.save"]).not.toHaveBeenCalled();
    expect(run["tab.close"]).not.toHaveBeenCalled();

    press({ key: "S", ctrlKey: true, shiftKey: true });
    press({ key: "n", ctrlKey: true });
    expect(run["script.save"]).toHaveBeenCalledOnce();
    expect(run["script.new"]).toHaveBeenCalledOnce();
  });

  it("ignore keys pressed while composing text", () => {
    const run = commands();
    uninstall.push(installKeybindings(window, run, () => ({})));

    press({ key: "s", ctrlKey: true, isComposing: true });

    expect(run["script.save"]).not.toHaveBeenCalled();
  });

  it("stop once uninstalled", () => {
    const run = commands();
    installKeybindings(window, run, () => ({}))();

    press({ key: "s", ctrlKey: true });

    expect(run["script.save"]).not.toHaveBeenCalled();
  });
});
