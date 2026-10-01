import { useId, useState, type ReactNode, type SyntheticEvent } from "react";
import { useTranslation } from "react-i18next";

import type { ScriptPath, TreeEntry } from "../../shared/ipc";
import { scriptTitle } from "../../shared/scripts";
import { Button } from "../../shared/ui/Button";
import { Dialog } from "../../shared/ui/Dialog";
import type { Actions } from "../actions";
import type { Dialog as DialogState, Message } from "../ui";

interface DialogsProps {
  readonly dialog: DialogState | null;
  /** Title of the tab the unsaved-changes dialog is about. */
  readonly tabTitle: (id: string) => string;
  /** Folders of the scripts tree, where "save as" can put a script. */
  readonly folders: readonly ScriptPath[];
  readonly actions: Actions;
}

/** The dialog the UI state asks for, if any. */
export function Dialogs({ dialog, tabTitle, folders, actions }: DialogsProps) {
  switch (dialog?.kind) {
    case "unsaved":
      return <UnsavedDialog title={tabTitle(dialog.tabId)} actions={actions} />;
    case "name":
      // Keyed by purpose so a new question starts from its own initial name.
      return (
        <NameDialog key={dialog.purpose} dialog={dialog} folders={folders} actions={actions} />
      );
    case "confirmDelete":
      return <DeleteDialog entry={dialog.entry} actions={actions} />;
    default:
      return null;
  }
}

function UnsavedDialog({ title, actions }: { readonly title: string; readonly actions: Actions }) {
  const { t } = useTranslation();
  const answer = (choice: "save" | "discard" | "cancel") => () => {
    void actions.resolveUnsaved(choice);
  };

  return (
    <Dialog title={t("dialogs.unsaved.title")} onDismiss={answer("cancel")}>
      <p className="text-sm">{t("dialogs.unsaved.message", { title })}</p>
      <Buttons>
        <Button onClick={answer("cancel")}>{t("common.cancel")}</Button>
        <Button onClick={answer("discard")}>{t("dialogs.unsaved.discard")}</Button>
        <Button variant="primary" initialFocus onClick={answer("save")}>
          {t("dialogs.unsaved.save")}
        </Button>
      </Buttons>
    </Dialog>
  );
}

function DeleteDialog({
  entry,
  actions,
}: {
  readonly entry: TreeEntry;
  readonly actions: Actions;
}) {
  const { t } = useTranslation();
  const name = entry.kind === "script" ? scriptTitle(entry.name) : entry.name;

  return (
    <Dialog title={t("dialogs.delete.title")} onDismiss={actions.cancelDialog}>
      <p className="text-sm">{t("dialogs.delete.message", { name })}</p>
      <Buttons>
        <Button initialFocus onClick={actions.cancelDialog}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            void actions.confirmDelete();
          }}
        >
          {t("dialogs.delete.confirm")}
        </Button>
      </Buttons>
    </Dialog>
  );
}

interface NameDialogProps {
  readonly dialog: Extract<DialogState, { kind: "name" }>;
  readonly folders: readonly ScriptPath[];
  readonly actions: Actions;
}

/** Value of the folder picker that stands for the top level of the scripts folder. */
const TOP_LEVEL = "";

function NameDialog({ dialog, folders, actions }: NameDialogProps) {
  const { t } = useTranslation();
  const nameId = useId();
  const folderId = useId();
  const [name, setName] = useState(dialog.initial);
  const [folder, setFolder] = useState(TOP_LEVEL);
  const [submitting, setSubmitting] = useState(false);

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (submitting || name.trim() === "") return;
    setSubmitting(true);
    void actions.submitName(name, folder === TOP_LEVEL ? null : folder).finally(() => {
      // Still mounted only when the name was refused: let the user fix it.
      setSubmitting(false);
    });
  };

  return (
    <Dialog title={t(`dialogs.name.${dialog.purpose}.title`)} onDismiss={actions.cancelDialog}>
      <form onSubmit={submit} className="flex flex-col gap-2 text-sm">
        <Field id={nameId} label={t("dialogs.name.label")}>
          <input
            id={nameId}
            data-autofocus
            value={name}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={dialog.error !== undefined}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="h-7 rounded border border-rule bg-paper px-2 text-ink outline-none select-text focus:border-accent"
          />
        </Field>
        {dialog.purpose === "saveAs" && folders.length > 0 && (
          <Field id={folderId} label={t("dialogs.name.folder")}>
            <select
              id={folderId}
              value={folder}
              onChange={(event) => {
                setFolder(event.target.value);
              }}
              className="h-7 rounded border border-rule bg-paper px-1 text-ink"
            >
              <option value={TOP_LEVEL}>{t("dialogs.name.topLevel")}</option>
              {folders.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </select>
          </Field>
        )}
        {dialog.error !== undefined && <Problem message={dialog.error} />}
        <Buttons>
          <Button onClick={actions.cancelDialog}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={submitting || name.trim() === ""}>
            {t(`dialogs.name.${dialog.purpose}.submit`)}
          </Button>
        </Buttons>
      </form>
    </Dialog>
  );
}

function Problem({ message }: { readonly message: Message }) {
  const { t } = useTranslation();
  return (
    <p role="alert" className="text-danger">
      {t(message.key, message.values ?? {})}
    </p>
  );
}

interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}

function Field({ id, label, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-pencil">
        {label}
      </label>
      {children}
    </div>
  );
}

function Buttons({ children }: { readonly children: ReactNode }) {
  return <div className="mt-3 flex justify-end gap-2">{children}</div>;
}
