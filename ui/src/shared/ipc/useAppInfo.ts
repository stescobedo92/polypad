import { useEffect, useState } from "react";

import { getAppInfo, type AppInfo } from "./index";

export type AppInfoState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly info: AppInfo }
  | { readonly status: "unavailable" };

/** Loads the build information once; resolves to `unavailable` outside the Tauri shell. */
export function useAppInfo(): AppInfoState {
  const [state, setState] = useState<AppInfoState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    getAppInfo().then(
      (info) => {
        if (active) setState({ status: "ready", info });
      },
      (error: unknown) => {
        console.error("app_info command failed", error);
        if (active) setState({ status: "unavailable" });
      },
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}
