/** The PolyPad mark (same drawing as the app icon), sized for the menu row. */
export function PolyPadMark() {
  return (
    <svg aria-hidden viewBox="0 0 1024 1024" className="size-4 shrink-0">
      <rect x="64" y="64" width="896" height="896" rx="200" className="fill-ink" />
      <rect x="224" y="292" width="432" height="96" rx="48" className="fill-lang-csharp" />
      <rect x="320" y="464" width="480" height="96" rx="48" className="fill-lang-go" />
      <rect x="224" y="636" width="304" height="96" rx="48" className="fill-lang-sql" />
      <rect x="568" y="612" width="44" height="144" rx="12" className="fill-desk" />
    </svg>
  );
}
