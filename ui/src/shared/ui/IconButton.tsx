import type { LucideIcon } from "lucide-react";

interface IconButtonProps {
  /** Accessible name, also shown as the tooltip. */
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
}

export function IconButton({ label, icon: Icon, disabled = false, onClick }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex size-6 items-center justify-center rounded text-pencil enabled:hover:bg-desk-raised enabled:hover:text-ink disabled:opacity-40"
    >
      <Icon aria-hidden size={14} strokeWidth={1.75} />
    </button>
  );
}
