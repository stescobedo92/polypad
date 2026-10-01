import "@testing-library/jest-dom/vitest";

import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { initI18n } from "../shared/i18n";

initI18n("en");

// What jsdom lacks and the components use. It lays nothing out, so there are no sizes to
// observe, nothing to scroll and no pointer to capture (Radix menus ask for the last two).
globalThis.ResizeObserver = class implements ResizeObserver {
  observe(): void {
    // No layout, no sizes.
  }
  unobserve(): void {
    // No layout, no sizes.
  }
  disconnect(): void {
    // No layout, no sizes.
  }
};

Object.assign(Element.prototype, {
  scrollIntoView(): void {
    // No layout, nothing to scroll.
  },
  hasPointerCapture: (): boolean => false,
  releasePointerCapture(): void {
    // No pointer to release.
  },
});

// With no layout every element is an empty box at the origin, which is also where simulated
// clicks land. react-resizable-panels would take each click for a grab of a separator and cancel
// it (so nothing would get the focus); separators are therefore reported far from there.
Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: Element) {
  return this.hasAttribute("data-separator") ? new DOMRect(-10_000, -10_000, 0, 0) : new DOMRect();
};

// jsdom has the <dialog> element but not the methods that open and close it.
Object.assign(HTMLDialogElement.prototype, {
  showModal(this: HTMLDialogElement): void {
    this.open = true;
  },
  close(this: HTMLDialogElement): void {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  },
});

afterEach(() => {
  cleanup();
  clearMocks();
});
