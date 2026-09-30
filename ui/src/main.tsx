import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { AppShell } from "./app/shell/AppShell";
import { detectLocale, initI18n } from "./shared/i18n";
import "./styles.css";

const i18n = initI18n(detectLocale(navigator.languages));
document.documentElement.lang = i18n.language;

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing the #root element");
}

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
