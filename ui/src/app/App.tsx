import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AppServices } from "./services";
import { AppShell } from "./shell/AppShell";
import { MenuBar } from "./shell/MenuBar";

type Start =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly services: AppServices }
  | { readonly status: "failed" };

/**
 * The window: the frame at once, the workspace when the session has started. `starting` comes
 * from `startApp`, which runs once per window outside React.
 */
export function App({ starting }: { readonly starting: Promise<AppServices> }) {
  const { t } = useTranslation();
  const [start, setStart] = useState<Start>({ status: "loading" });

  useEffect(() => {
    let active = true;
    starting.then(
      (services) => {
        if (active) setStart({ status: "ready", services });
      },
      (error: unknown) => {
        console.error("the workspace could not be started", error);
        if (active) setStart({ status: "failed" });
      },
    );
    return () => {
      active = false;
    };
  }, [starting]);

  if (start.status === "ready") {
    return <AppShell services={start.services} />;
  }
  return (
    <div className="grid h-full grid-rows-[auto_1fr]">
      <MenuBar />
      <div className="flex items-center justify-center px-6 text-center text-sm text-pencil">
        {start.status === "loading" ? (
          <p role="status">{t("editor.loading")}</p>
        ) : (
          <p role="alert">{t("editor.failed")}</p>
        )}
      </div>
    </div>
  );
}
