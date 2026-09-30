import type { LanguageId } from "../languages";

/** Small square in the language's hue; `data-language` resolves the colour through CSS. */
export function LanguageSwatch({ language }: { readonly language: LanguageId }) {
  return (
    <span
      aria-hidden
      data-language={language}
      className="inline-block size-2 shrink-0 rounded-[2px] bg-accent"
    />
  );
}
