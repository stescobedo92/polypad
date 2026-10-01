import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import type { CursorPosition } from "../../features/editor/editorModule";
import type { Newline } from "../../shared/ipc";
import { useAppInfo } from "../../shared/ipc/useAppInfo";
import type { ExecutionMode, Language } from "../../shared/languages";
import { LanguageSwatch } from "../../shared/ui/LanguageSwatch";

/** What the status bar says about the script of the active tab. */
export interface ScriptStatus {
  readonly language: Language;
  readonly mode: ExecutionMode;
  readonly cursor: CursorPosition;
  readonly newline: Newline;
}

interface StatusBarProps {
  /** `null` when no script is open. */
  readonly script: ScriptStatus | null;
}

/** Kernel state, script context and build information along the bottom edge. */
export function StatusBar({ script }: StatusBarProps) {
  const { t } = useTranslation();
  const appInfo = useAppInfo();

  return (
    <footer
      aria-label={t("status.label")}
      className="flex h-6 items-stretch border-t border-rule bg-desk text-2xs text-pencil"
    >
      <Segment>
        <span aria-hidden className="size-1.5 rounded-full bg-faint" />
        {t("status.kernelIdle")}
      </Segment>
      {script !== null && (
        <>
          <Segment>
            <LanguageSwatch language={script.language.id} />
            {script.language.label}
          </Segment>
          <Segment>{t(`modes.${script.mode}`)}</Segment>
        </>
      )}
      <Segment>{t("status.noConnection")}</Segment>

      <div className="ml-auto flex items-stretch">
        {script !== null && (
          <>
            <Segment trailing>
              {t("status.position", { line: script.cursor.line, column: script.cursor.column })}
            </Segment>
            <Segment trailing>{t(`status.lineEnding.${script.newline}`)}</Segment>
          </>
        )}
        <Segment trailing>{t("status.encoding")}</Segment>
        <Segment trailing>
          {appInfo.status === "ready" && t("status.version", { version: appInfo.info.version })}
          {appInfo.status === "unavailable" && t("status.versionUnavailable")}
        </Segment>
      </div>
    </footer>
  );
}

function Segment({ children, trailing = false }: { children: ReactNode; trailing?: boolean }) {
  return (
    <span
      className={`flex items-center gap-1.5 border-rule px-2.5 ${trailing ? "border-l" : "border-r"}`}
    >
      {children}
    </span>
  );
}
