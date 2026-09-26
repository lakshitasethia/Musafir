/** Torn paper strip from the landing page, used as a section divider. Presentational only. */
export function TornEdge({ flip = false, onDark = false }: { flip?: boolean; onDark?: boolean }) {
  return <span aria-hidden="true" className={`mz-torn${flip ? " is-flipped" : ""}${onDark ? " on-dark" : ""}`} />;
}
