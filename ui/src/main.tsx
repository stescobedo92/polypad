import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { startApp } from "./app/services";
import { loadEditorModule } from "./features/editor/editorModule";
import { detectLocale, initI18n } from "./shared/i18n";
import * as ipc from "./shared/ipc";
import "./styles.css";

const i18n = initI18n(detectLocale(navigator.languages));
document.documentElement.lang = i18n.language;

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html is missing the #root element");
}

// Started here rather than in an effect: the editor chunk and the first IPC round trip begin
// while React renders the frame, and a development double render cannot start it twice.
const starting = startApp({ ipc, loadEditor: loadEditorModule });

createRoot(container).render(
  <StrictMode>
    <App starting={starting} />
  </StrictMode>,
);
