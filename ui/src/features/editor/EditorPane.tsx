import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { Language } from "../../shared/languages";

/** Code editor. Monaco is loaded lazily so the shell paints before its ~4 MB chunk. */
export function EditorPane({ language }: { readonly language: Language }) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let dispose: (() => void) | undefined;
    void import("./monaco/monaco").then(({ createCodeEditor }) => {
      if (disposed || container.current === null) return;
      const editor = createCodeEditor(container.current, {
        code: `${language.lineComment} ${t("editor.placeholder", { language: language.label })}\n`,
        language: language.id,
        dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      });
      dispose = () => {
        editor.dispose();
      };
    });
    return () => {
      disposed = true;
      dispose?.();
    };
  }, [language, t]);

  return (
    <section aria-label={t("editor.label")} className="min-h-0 overflow-hidden bg-paper pt-2">
      <div ref={container} className="h-full" />
    </section>
  );
}
