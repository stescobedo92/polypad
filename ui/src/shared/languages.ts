/** Execution modes a kernel can offer (spec section 5). */
export const EXECUTION_MODES = [
  "expression",
  "statements",
  "program",
  "script",
  "module",
  "sql",
] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface LanguageDefinition {
  /** Stable identifier; also the value of the `data-language` attribute that sets the accent. */
  readonly id: string;
  /** Proper name shown in the UI. Language names are not translated. */
  readonly label: string;
  /** Modes in the order they are offered; the first one is the default. */
  readonly modes: readonly [ExecutionMode, ...ExecutionMode[]];
  /** Token that starts a line comment. */
  readonly lineComment: "//" | "#" | "--";
}

export const LANGUAGES = [
  { id: "csharp", label: "C#", modes: ["statements", "expression", "program"], lineComment: "//" },
  { id: "fsharp", label: "F#", modes: ["script", "expression"], lineComment: "//" },
  { id: "java", label: "Java", modes: ["statements", "expression", "program"], lineComment: "//" },
  { id: "kotlin", label: "Kotlin", modes: ["script"], lineComment: "//" },
  { id: "go", label: "Go", modes: ["statements", "program"], lineComment: "//" },
  {
    id: "typescript",
    label: "TypeScript",
    modes: ["statements", "expression", "module"],
    lineComment: "//",
  },
  {
    id: "javascript",
    label: "JavaScript",
    modes: ["statements", "expression", "module"],
    lineComment: "//",
  },
  { id: "python", label: "Python", modes: ["script", "expression"], lineComment: "#" },
  { id: "rust", label: "Rust", modes: ["statements"], lineComment: "//" },
  { id: "sql", label: "SQL", modes: ["sql"], lineComment: "--" },
] as const satisfies readonly LanguageDefinition[];

export type LanguageId = (typeof LANGUAGES)[number]["id"];

/** A catalogue entry with its identifier narrowed to the known ids. */
export type Language = LanguageDefinition & { readonly id: LanguageId };

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
