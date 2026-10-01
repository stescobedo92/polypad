/**
 * Keyboard shortcuts of the window. A chord is written `Ctrl+Shift+P`: modifiers in a fixed
 * order, then the key. The preferences may give a command another chord, or none (`null`).
 */

/** The commands this PR binds; the full registry arrives with the command palette. */
export type CommandId = "script.new" | "script.save" | "tab.close";

const DEFAULT_CHORDS: Readonly<Record<CommandId, string>> = {
  "script.new": "Ctrl+N",
  "script.save": "Ctrl+S",
  "tab.close": "Ctrl+W",
};

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
type Modifier = (typeof MODIFIERS)[number];

/** Keys that are modifiers themselves: pressing one alone is not a chord. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Control", "Alt", "Shift", "Meta"]);

function keyName(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

function compose(held: ReadonlySet<Modifier>, key: string): string {
  return [...MODIFIERS.filter((modifier) => held.has(modifier)), keyName(key)].join("+");
}

/** The chord a key press stands for, or `null` when only modifiers are down. */
export function chordOf(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const held = new Set<Modifier>();
  if (event.ctrlKey) held.add("Ctrl");
  if (event.altKey) held.add("Alt");
  if (event.shiftKey) held.add("Shift");
  if (event.metaKey) held.add("Meta");
  return compose(held, event.key);
}

/** A chord as `chordOf` writes it, however the preferences spelled it. */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((part) => part.trim());
  const held = new Set<Modifier>();
  let key = "";
  for (const part of parts) {
    const modifier = MODIFIERS.find((name) => name.toLowerCase() === part.toLowerCase());
    if (modifier === undefined) {
      key = part;
    } else {
      held.add(modifier);
    }
  }
  return compose(held, key);
}

/**
 * Runs `commands` on their chords until the returned function is called. `overrides` is read
 * on every key press, so a change of preferences applies at once.
 */
export function installKeybindings(
  target: Window,
  commands: Readonly<Record<CommandId, () => void>>,
  overrides: () => Readonly<Record<string, string | null | undefined>>,
): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing) return;
    const chord = chordOf(event);
    if (chord === null) return;
    const custom = overrides();
    for (const [id, fallback] of Object.entries(DEFAULT_CHORDS) as [CommandId, string][]) {
      const bound = id in custom ? custom[id] : fallback;
      if (bound != null && normalizeChord(bound) === chord) {
        // The WebView would otherwise act on it too (Ctrl+S saves the page, Ctrl+W closes it).
        event.preventDefault();
        event.stopPropagation();
        commands[id]();
        return;
      }
    }
  };
  // Capture phase: the editor handles keys itself and would swallow them first.
  target.addEventListener("keydown", onKeyDown, { capture: true });
  return () => {
    target.removeEventListener("keydown", onKeyDown, { capture: true });
  };
}
