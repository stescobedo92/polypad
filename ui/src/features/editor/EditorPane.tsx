import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import type { BufferId } from "../../shared/ipc";
import { Button } from "../../shared/ui/Button";
import type { TextBuffers } from "../workspace/textBuffers";
import type { CursorPosition, EditorHandle, EditorModule } from "./editorModule";

interface EditorPaneProps {
  readonly editor: EditorModule;
  readonly buffers: TextBuffers;
  /** The buffer to show; `null` when no script is open. */
  readonly activeId: BufferId | null;
  /** Must keep its identity between renders: a new one subscribes again. */
  readonly onCursorChange: (position: CursorPosition) => void;
  /** Hands out the editor once it exists (and `null` when it is gone), to focus it. */
  readonly onReady: (handle: EditorHandle | null) => void;
  readonly onNewScript: () => void;
}

/** The code editor, showing the buffer of the active tab. */
export function EditorPane({
  editor,
  buffers,
  activeId,
  onCursorChange,
  onReady,
  onNewScript,
}: EditorPaneProps) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const handle = useRef<EditorHandle | null>(null);

  useEffect(() => {
    if (container.current === null) return;
    const mounted = editor.mount(container.current, buffers);
    handle.current = mounted;
    onReady(mounted);
    return () => {
      onReady(null);
      handle.current = null;
      mounted.dispose();
    };
  }, [editor, buffers, onReady]);

  // These run after the effect above and share its dependencies, so an editor that is created
  // again shows the buffer and reports its cursor too.
  useEffect(() => {
    handle.current?.show(activeId);
  }, [activeId, editor, buffers, onReady]);

  useEffect(
    () => handle.current?.onCursorChange(onCursorChange),
    [onCursorChange, editor, buffers, onReady],
  );

  return (
    <section
      aria-label={t("editor.label")}
      className="relative h-full min-h-0 overflow-hidden bg-paper pt-2"
    >
      <div ref={container} className="h-full" />
      {activeId === null && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-paper text-sm text-pencil">
          <p>{t("editor.empty")}</p>
          <Button onClick={onNewScript}>{t("editor.startScript")}</Button>
        </div>
      )}
    </section>
  );
}
