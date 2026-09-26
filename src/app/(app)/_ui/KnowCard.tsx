/**
 * One verified fact, shaped like the entries Parth's `src/data/` datasets carry
 * (CLAUDE.md §10: every entry has a `source` URL and a `checkedOn` date).
 * `value: null` means the dataset has no verified answer — shown as such, never filled in.
 */
export interface KnowFact {
  label: string;
  value: string | null;
  source?: string;
  checkedOn?: string;
}

/** Tap-to-read "Know before you go" card. Collapsed by default; no chat, no free text. */
export function KnowCard({ title, facts, defaultOpen = false }: { title: string; facts: KnowFact[]; defaultOpen?: boolean }) {
  return (
    <details className="mz-know" open={defaultOpen}>
      <summary>
        <span className="mz-display mz-h3">{title}</span>
        <span className="mz-label">{facts.length} {facts.length === 1 ? "fact" : "facts"}</span>
      </summary>
      <dl className="mz-know-facts">
        {facts.map((f) => (
          <div key={f.label} className={`mz-know-fact${f.value === null ? " is-unverified" : ""}`}>
            <dt>{f.label}</dt>
            <dd>{f.value ?? "Not verified — check locally"}</dd>
            {(f.source || f.checkedOn) && (
              <span className="mz-know-source">
                {f.source ? (
                  <a href={f.source} target="_blank" rel="noopener noreferrer">
                    Source
                  </a>
                ) : (
                  "Source"
                )}
                {f.checkedOn ? ` · checked ${f.checkedOn}` : ""}
              </span>
            )}
          </div>
        ))}
      </dl>
    </details>
  );
}
