/** Editorial section header: index number, eyebrow label, huge serif heading over a hairline. */
export function SectionHeader({
  index,
  eyebrow,
  title,
  aside,
  dark = false,
  as: Heading = "h2",
}: {
  index?: number;
  eyebrow?: string;
  title: string;
  aside?: React.ReactNode;
  dark?: boolean;
  as?: "h1" | "h2" | "h3";
}) {
  return (
    <header className={`mz-section-head${dark ? " is-dark" : ""}`}>
      {(index !== undefined || eyebrow) && (
        <div className="mz-section-head-top">
          {index !== undefined && <span className="mz-section-index mz-mono">{String(index).padStart(2, "0")}</span>}
          {eyebrow && <span className="mz-label">{eyebrow}</span>}
        </div>
      )}
      <div className="mz-spread" style={{ alignItems: "end" }}>
        <Heading className={`mz-display ${Heading === "h1" ? "mz-h1" : "mz-h2"}`}>{title}</Heading>
        {aside}
      </div>
    </header>
  );
}
