import { Plus, Search } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LANGUAGES } from "../../shared/languages";
import { IconButton } from "../../shared/ui/IconButton";
import { LanguageSwatch } from "../../shared/ui/LanguageSwatch";

/** Left column: connections, the user's scripts and the bundled samples. */
export function ExplorerSidebar() {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t("explorer.label")}
      className="flex min-h-0 flex-col gap-4 overflow-y-auto bg-desk py-2"
    >
      <SidebarSection
        title={t("explorer.connections.title")}
        action={<IconButton label={t("explorer.connections.add")} icon={Plus} disabled />}
      >
        <EmptyNote>{t("explorer.connections.empty")}</EmptyNote>
      </SidebarSection>

      <SidebarSection
        title={t("explorer.scripts.title")}
        action={<IconButton label={t("explorer.scripts.search")} icon={Search} disabled />}
      >
        <EmptyNote>{t("explorer.scripts.empty")}</EmptyNote>
      </SidebarSection>

      <SidebarSection title={t("explorer.samples.title")}>
        <ul>
          {LANGUAGES.map((language) => (
            <li key={language.id} className="flex h-6 items-center gap-2 px-3 text-sm">
              <LanguageSwatch language={language.id} />
              {language.label}
            </li>
          ))}
        </ul>
      </SidebarSection>
    </aside>
  );
}

interface SidebarSectionProps {
  readonly title: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

function SidebarSection({ title, action, children }: SidebarSectionProps) {
  return (
    <section aria-label={title}>
      <div className="flex h-7 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-semibold text-pencil">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptyNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 text-xs text-faint">{children}</p>;
}
