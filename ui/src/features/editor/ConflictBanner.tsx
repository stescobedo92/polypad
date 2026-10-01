import { useTranslation } from "react-i18next";

import { Button } from "../../shared/ui/Button";
import type { DiskState } from "../workspace/workspace";

interface ConflictBannerProps {
  /** What happened to the file of the active tab. */
  readonly disk: Exclude<DiskState, "same">;
  readonly onReload: () => void;
  readonly onKeepMine: () => void;
  readonly onSave: () => void;
}

/** Says that the file of the active tab changed or disappeared, and offers the ways out. */
export function ConflictBanner({ disk, onReload, onKeepMine, onSave }: ConflictBannerProps) {
  const { t } = useTranslation();

  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule bg-desk-raised px-3 py-1.5 text-sm"
    >
      <p className="mr-auto">{t(`editor.conflict.${disk}`)}</p>
      {disk === "changed" ? (
        <>
          <Button onClick={onReload}>{t("editor.conflict.reload")}</Button>
          <Button onClick={onKeepMine}>{t("editor.conflict.keepMine")}</Button>
        </>
      ) : (
        <Button onClick={onSave}>{t("editor.conflict.save")}</Button>
      )}
    </div>
  );
}
