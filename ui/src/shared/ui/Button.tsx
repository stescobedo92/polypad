import type { ReactNode } from "react";

interface ButtonProps {
  readonly children: ReactNode;
  /** `primary` is the action the dialog or banner is about. */
  readonly variant?: "primary" | "plain";
  readonly type?: "button" | "submit";
  readonly disabled?: boolean;
  /** Takes the focus when the dialog it is in opens. */
  readonly initialFocus?: boolean;
  readonly onClick?: () => void;
}

const VARIANTS = {
  primary: "border-accent bg-accent text-paper enabled:hover:opacity-90",
  plain: "border-rule bg-paper text-ink enabled:hover:border-pencil",
} as const;

export function Button({
  children,
  variant = "plain",
  type = "button",
  disabled = false,
  initialFocus = false,
  onClick,
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      data-autofocus={initialFocus ? "" : undefined}
      onClick={onClick}
      className={`h-7 rounded border px-3 text-sm disabled:opacity-40 ${VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}
