import { useEffect, useId, useRef, type ReactNode } from "react";

interface DialogProps {
  readonly title: string;
  /** Escape was pressed. */
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

/**
 * A modal dialog on the native `<dialog>` element: the browser traps focus, makes the rest of
 * the window inert and closes on Escape. Mount it to open it; unmount it to close it.
 *
 * Focus starts on the element marked `data-autofocus` (its text selected, for an input) and goes
 * back to where it was when the dialog closes.
 */
export function Dialog({ title, onDismiss, children }: DialogProps) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = element.current;
    if (dialog === null) return;
    // Browsers only give the focus back when a dialog closes while still in the document, which
    // an unmounted one is not; done by hand so the user carries on where they were.
    const opener = document.activeElement;
    dialog.showModal();
    const first = dialog.querySelector<HTMLElement>("[data-autofocus]");
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  return (
    <dialog
      ref={element}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // The owner closes it by unmounting, so the state stays in one place.
        event.preventDefault();
        onDismiss();
      }}
      className="m-auto w-88 max-w-[calc(100vw-2rem)] rounded border border-rule bg-paper p-4 text-ink shadow-xl backdrop:bg-black/30"
    >
      <h2 id={titleId} className="mb-3 text-sm font-semibold">
        {title}
      </h2>
      {children}
    </dialog>
  );
}
