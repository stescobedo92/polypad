import { FilePlus, FolderOpen, FolderPlus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { LANGUAGES } from "../../shared/languages";
import { IconButton } from "../../shared/ui/IconButton";
import { LanguageSwatch } from "../../shared/ui/LanguageSwatch";
import type { ExplorerState } from "./explorer";
import { ScriptTree, type ScriptTreeProps } from "./ScriptTree";

type TreeHandlers = Pick<
  ScriptTreeProps,
  | "activePath"
  | "onToggle"
  | "onOpen"
  | "onNewScript"
  | "onNewFolder"
  | "onRename"
  | "onDelete"
  | "onMove"
  | "onMoveTo"
>;

interface ExplorerSidebarProps extends TreeHandlers {
  readonly explorer: ExplorerState;
  readonly onChooseFolder: () => void;
}

/** Left column: connections, the scripts folder and the bundled samples. */
export function ExplorerSidebar({ explorer, onChooseFolder, ...tree }: ExplorerSidebarProps) {
  const { t } = useTranslation();
  const { folderName, tree: scripts, unavailableFolder, expanded } = explorer;

  return (
    <aside
      aria-label={t("explorer.label")}
      className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto bg-desk py-2"
    >
      <SidebarSection
        title={t("explorer.connections.title")}
        action={<IconButton label={t("explorer.connections.add")} icon={Plus} disabled />}
      >
        <EmptyNote>{t("explorer.connections.empty")}</EmptyNote>
      </SidebarSection>

      <SidebarSection
        title={t("explorer.scripts.title")}
        grow
        action={
          <>
            <IconButton
              label={t("explorer.scripts.newScript")}
              icon={FilePlus}
              disabled={scripts === null}
              onClick={() => {
                tree.onNewScript(null);
              }}
            />
            <IconButton
              label={t("explorer.scripts.newFolder")}
              icon={FolderPlus}
              disabled={scripts === null}
              onClick={() => {
                tree.onNewFolder(null);
              }}
            />
            <IconButton
              label={t("explorer.scripts.chooseFolder")}
              icon={FolderOpen}
              onClick={onChooseFolder}
            />
          </>
        }
      >
        {unavailableFolder !== null && (
          <p role="note" className="mx-3 mb-1.5 rounded border border-rule px-2 py-1 text-xs">
            {t("explorer.scripts.unavailable", { folder: unavailableFolder })}
          </p>
        )}
        {scripts === null ? (
          <EmptyNote>{t("explorer.scripts.noFolder")}</EmptyNote>
        ) : (
          <>
            {folderName !== null && folderName !== "" && (
              <p className="truncate px-3 pb-1 text-xs text-faint" title={folderName}>
                {folderName}
              </p>
            )}
            {scripts.entries.length === 0 && <EmptyNote>{t("explorer.scripts.empty")}</EmptyNote>}
            <ScriptTree
              label={t("explorer.scripts.tree")}
              entries={scripts.entries}
              expanded={expanded}
              {...tree}
            />
            {scripts.truncated && <EmptyNote>{t("explorer.scripts.truncated")}</EmptyNote>}
          </>
        )}
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
  /** Takes the space the other sections leave. */
  readonly grow?: boolean;
  readonly children: ReactNode;
}

function SidebarSection({ title, action, grow = false, children }: SidebarSectionProps) {
  return (
    <section aria-label={title} className={grow ? "flex min-h-24 flex-1 flex-col" : undefined}>
      <div className="flex h-7 shrink-0 items-center justify-between pr-1.5 pl-3">
        <h2 className="text-xs font-semibold text-pencil">{title}</h2>
        <div className="flex items-center">{action}</div>
      </div>
      {children}
    </section>
  );
}

function EmptyNote({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 text-xs text-faint">{children}</p>;
}
