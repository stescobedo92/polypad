import "@testing-library/jest-dom/vitest";

import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { initI18n } from "../shared/i18n";

initI18n("en");

afterEach(() => {
  cleanup();
  clearMocks();
});
