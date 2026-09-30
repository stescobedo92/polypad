import { ChevronDown, Play, Square } from "lucide-react";
import { useId, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  LANGUAGES,
  isLanguageId,
  type ExecutionMode,
  type Language,
  type LanguageId,
} from "../../shared/languages";

interface EditorToolbarProps {
  readonly language: Language;
  readonly mode: ExecutionMode;
  readonly onLanguageChange: (language: LanguageId) => void;
  readonly onModeChange: (mode: ExecutionMode) => void;
}

/** Language, mode and connection pickers plus the run controls for the active script. */
export function EditorToolbar({
  language,
  mode,
  onLanguageChange,
  onModeChange,
}: EditorToolbarProps) {
  const { t } = useTranslation();

  return (
    <div
      role="group"
      aria-label={t("toolbar.label")}
      className="flex h-9 shrink-0 items-center gap-4 border-b border-rule bg-paper px-3"
    >
      <Picker
        label={t("toolbar.language")}
        value={language.id}
        onChange={(value) => {
          if (isLanguageId(value)) onLanguageChange(value);
        }}
      >
        {LANGUAGES.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </Picker>

      <Picker
        label={t("toolbar.mode")}
        value={mode}
        disabled={language.modes.length === 1}
        onChange={(value) => {
          const next = language.modes.find((candidate) => candidate === value);
          if (next !== undefined) onModeChange(next);
        }}
      >
        {language.modes.map((option) => (
          <option key={option} value={option}>
            {t(`modes.${option}`)}
          </option>
        ))}
      </Picker>

      <Picker label={t("toolbar.connection")} value="none" disabled>
        <option value="none">{t("toolbar.noConnection")}</option>
      </Picker>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          disabled
          title={t("toolbar.runHint")}
          className="flex h-6 items-center gap-1.5 rounded border border-rule px-2 text-sm disabled:opacity-40"
        >
          <Play aria-hidden size={12} className="fill-accent text-accent" />
          {t("toolbar.run")}
          <kbd className="font-code text-2xs text-faint">F5</kbd>
        </button>
        <button
          type="button"
          disabled
          title={t("toolbar.stopHint")}
          className="flex h-6 items-center gap-1.5 rounded border border-rule px-2 text-sm disabled:opacity-40"
        >
          <Square aria-hidden size={11} />
          {t("toolbar.stop")}
        </button>
        <span
          role="timer"
          aria-label={t("toolbar.elapsed")}
          className="w-[9ch] text-right font-code text-sm text-pencil tabular-nums"
        >
          00:00.000
        </span>
      </div>
    </div>
  );
}

interface PickerProps {
  readonly label: string;
  readonly value: string;
  readonly disabled?: boolean;
  readonly onChange?: (value: string) => void;
  readonly children: ReactNode;
}

function Picker({ label, value, disabled = false, onChange, children }: PickerProps) {
  const id = useId();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={id} className="text-xs text-pencil">
        {label}
      </label>
      <span className="relative flex items-center">
        <select
          id={id}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange?.(event.target.value)}
          className="h-6 appearance-none rounded border border-rule bg-paper pr-6 pl-2 text-sm text-ink enabled:hover:border-pencil disabled:opacity-40"
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          size={12}
          className="pointer-events-none absolute right-1.5 text-pencil"
        />
      </span>
    </div>
  );
}
