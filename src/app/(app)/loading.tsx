/**
 * Shown the instant an app link is clicked while the next page renders on the
 * server (every app page is dynamic). Next prefetches this, so navigation never
 * sits on the old page waiting. Same top-bar frame as TopBar, so nothing jumps.
 */
export default function Loading() {
  return (
    <>
      <header className="mz-topbar" aria-hidden="true">
        <span className="mz-brand">Musafir</span>
      </header>
      <main className="mz-shell" style={{ paddingTop: 48 }} aria-busy="true">
        <p className="mz-small mz-muted" role="status" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="mz-pulse" aria-hidden="true" />
          Loading…
        </p>
      </main>
    </>
  );
}
