import { X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "../../shared/ui/IconButton";
import type { Message } from "../ui";

interface NoticesProps {
  /** What the last failed action, or start-up, has to say. */
  readonly notice: Message | null;
  readonly onDismissNotice: () => void;
  /** Unsaved work is not being journaled, so a crash would lose it. */
  readonly recoveryUnavailable: boolean;
}

/** Messages that do not block the work, in a strip under the menu until dismissed. */
export function Notices({ notice, onDismissNotice, recoveryUnavailable }: NoticesProps) {
  const { t } = useTranslation();
  // Said once: editing goes on without recovery, and repeating it would only get in the way.
  const [recoveryDismissed, setRecoveryDismissed] = useState(false);
  const showRecovery = recoveryUnavailable && !recoveryDismissed;

  if (notice === null && !showRecovery) return null;

  return (
    <div aria-label={t("notices.label")} role="group" className="border-b border-rule">
      {showRecovery && (
        <Strip
          role="status"
          onDismiss={() => {
            setRecoveryDismissed(true);
          }}
        >
          {t("errors.recoveryUnavailable")}
        </Strip>
      )}
      {notice !== null && (
        <Strip role="alert" onDismiss={onDismissNotice}>
          {t(notice.key, notice.values ?? {})}
        </Strip>
      )}
    </div>
  );
}

interface StripProps {
  readonly role: "alert" | "status";
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

function Strip({ role, onDismiss, children }: StripProps) {
  const { t } = useTranslation();
  return (
    <div
      role={role}
      className="flex min-h-7 items-center gap-2 bg-desk-raised py-0.5 pr-1.5 pl-3 text-sm select-text"
    >
      <p className="mr-auto">{children}</p>
      <IconButton label={t("common.dismiss")} icon={X} onClick={onDismiss} />
    </div>
  );
}
