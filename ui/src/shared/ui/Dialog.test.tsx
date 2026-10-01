import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

function Harness({ onDismiss = () => undefined }: { readonly onDismiss?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open
      </button>
      {open && (
        <Dialog title="Rename" onDismiss={onDismiss}>
          <input aria-label="Name" data-autofocus defaultValue="draft" />
          <button
            type="button"
            onClick={() => {
              setOpen(false);
            }}
          >
            Done
          </button>
        </Dialog>
      )}
    </>
  );
}

describe("Dialog", () => {
  it("opens as a modal named by its title", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog", { name: "Rename" });
    expect(dialog).toHaveAttribute("open");
  });

  it("starts on the marked element with its text selected", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Open" }));

    const name = screen.getByLabelText<HTMLInputElement>("Name");
    expect(name).toHaveFocus();
    expect([name.selectionStart, name.selectionEnd]).toEqual([0, 5]);
  });

  it("gives the focus back to where it was when it closes", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });

    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("asks to be dismissed on Escape instead of closing by itself", async () => {
    const onDismiss = vi.fn();
    const user = userEvent.setup();
    render(<Harness onDismiss={onDismiss} />);
    await user.click(screen.getByRole("button", { name: "Open" }));

    // What the browser sends for Escape on a modal dialog.
    const cancel = new Event("cancel", { cancelable: true });
    screen.getByRole("dialog").dispatchEvent(cancel);

    expect(onDismiss).toHaveBeenCalledOnce();
    expect(cancel.defaultPrevented).toBe(true);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
