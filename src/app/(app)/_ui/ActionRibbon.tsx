/**
 * Bottom ribbon that docks pending action cards: a one-line bar ("2 need you") that expands into a
 * swipeable row of cards on phones, and a floating stack on desktop. Controlled: the parent owns `open`.
 * Render nothing when there's nothing to decide — an empty ribbon is noise.
 */
export function ActionRibbon({
  count,
  open,
  onToggle,
  title = count === 1 ? "1 needs you" : `${count} need you`,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <aside className={`mz-ribbon${open ? " is-open" : ""}`} aria-label="Pending action cards">
      <button type="button" className="mz-ribbon-bar" aria-expanded={open} onClick={onToggle}>
        <span className="mz-row" style={{ flexWrap: "nowrap" }}>
          <span className="mz-ribbon-count">{count}</span>
          <span className="mz-ribbon-title">{title}</span>
        </span>
        <svg className="mz-ribbon-chevron" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3 10l5-5 5 5" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <div className="mz-ribbon-track">{children}</div>
    </aside>
  );
}
