import { useRef, type KeyboardEvent, type ReactNode } from "react";

interface TabListProps<T extends string> {
  /** Accessible name of the tab list. */
  readonly label: string;
  readonly tabs: readonly T[];
  readonly active: T;
  readonly onSelect: (tab: T) => void;
  readonly renderTab: (tab: T) => ReactNode;
  /** Prefix for element ids; tab `x` gets `${idPrefix}-tab-x` and controls `${idPrefix}-panel`. */
  readonly idPrefix: string;
}

/**
 * WAI-ARIA tabs with automatic activation: arrow keys move and select, Home/End jump to the
 * ends, and only the active tab is in the Tab sequence (roving tabindex).
 */
export function TabList<T extends string>({
  label,
  tabs,
  active,
  onSelect,
  renderTab,
  idPrefix,
}: TabListProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());

  const focusTab = (index: number) => {
    const count = tabs.length;
    const tab = tabs[((index % count) + count) % count];
    if (tab === undefined) return;
    onSelect(tab);
    buttons.current.get(tab)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.indexOf(active);
    const moves: Partial<Record<string, number>> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      Home: 0,
      End: tabs.length - 1,
    };
    const target = moves[event.key];
    if (target === undefined) return;
    event.preventDefault();
    focusTab(target);
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-8 shrink-0 items-stretch gap-4 border-b border-rule px-3"
    >
      {tabs.map((tab) => {
        const selected = tab === active;
        return (
          <button
            key={tab}
            ref={(element) => {
              if (element) buttons.current.set(tab, element);
              else buttons.current.delete(tab);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab}`}
            aria-controls={`${idPrefix}-panel`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onSelect(tab);
            }}
            className="relative text-sm text-pencil after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 hover:text-ink aria-selected:text-ink aria-selected:after:bg-accent"
          >
            {renderTab(tab)}
          </button>
        );
      })}
    </div>
  );
}
