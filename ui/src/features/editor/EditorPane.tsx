import { useTranslation } from "react-i18next";

import type { Language } from "../../shared/languages";

/** Placeholder for the code editor; Monaco replaces it in Phase 1. */
export function EditorPane({ language }: { readonly language: Language }) {
  const { t } = useTranslation();

  return (
    <section
      aria-label={t("editor.label")}
      className="flex min-h-0 overflow-hidden bg-paper pt-2 font-code text-sm"
    >
      <div aria-hidden className="w-12 shrink-0 pr-4 text-right text-faint tabular-nums">
        1
      </div>
      <p className="text-faint italic">
        {language.lineComment} {t("editor.placeholder", { language: language.label })}
      </p>
    </section>
  );
}
