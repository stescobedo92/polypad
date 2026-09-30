import { LANGUAGE_MODES, type ExecutionMode, type LanguageId } from "./ipc";

export type { ExecutionMode, LanguageId };

type LineComment = "//" | "#" | "--";

/**
 * What the UI adds to the language catalogue that comes from Rust (ids and modes). Listing a
 * presentation for every id is checked by the compiler, so a language added in Rust cannot
 * reach the UI without a label.
 */
const PRESENTATION = {
  csharp: { label: "C#", lineComment: "//" },
  fsharp: { label: "F#", lineComment: "//" },
  java: { label: "Java", lineComment: "//" },
  kotlin: { label: "Kotlin", lineComment: "//" },
  go: { label: "Go", lineComment: "//" },
  typescript: { label: "TypeScript", lineComment: "//" },
  javascript: { label: "JavaScript", lineComment: "//" },
  python: { label: "Python", lineComment: "#" },
  rust: { label: "Rust", lineComment: "//" },
  sql: { label: "SQL", lineComment: "--" },
} as const satisfies Record<LanguageId, { label: string; lineComment: LineComment }>;

export interface Language {
  /** Stable identifier; also the value of the `data-language` attribute that sets the accent. */
  readonly id: LanguageId;
  /** Proper name shown in the UI. Language names are not translated. */
  readonly label: string;
  /** Modes in the order they are offered; the first one is the default. */
  readonly modes: readonly [ExecutionMode, ...ExecutionMode[]];
  /** Token that starts a line comment. */
  readonly lineComment: LineComment;
}

/** Every language, in the order the backend lists them. */
export const LANGUAGES: readonly Language[] = LANGUAGE_MODES.map(({ language, modes }) => ({
  id: language,
  modes,
  ...PRESENTATION[language],
}));

export const DEFAULT_LANGUAGE: LanguageId = "csharp";

export function findLanguage(id: LanguageId): Language {
  const language = LANGUAGES.find((candidate) => candidate.id === id);
  if (language === undefined) {
    throw new Error(`Unknown language id: ${id}`);
  }
  return language;
}

export function isLanguageId(value: string): value is LanguageId {
  return LANGUAGES.some((language) => language.id === value);
}
