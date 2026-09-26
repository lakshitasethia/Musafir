import type { VibeConfig } from "@/lib/musafir/schemas.ts";

/**
 * A package as a destination-style card: photo with a style tag and rhythm
 * chip, pace line, big serif title, blurb, then budget and a Plan action.
 * Presentational only. Every label comes from the package's own vibe;
 * packages are travel styles, so there are no prices or ratings to show.
 */

// Photos and style tags per package id (our own images).
const ART: Record<string, { image: string; tag: string }> = {
  heritage: { image: "/images/package-heritage.jpg", tag: "Heritage" },
  slow: { image: "/images/package-slow.jpg", tag: "Slow travel" },
  local: { image: "/images/package-local.jpg", tag: "Night owl" },
  marathon: { image: "/images/package-marathon.jpg", tag: "Marathon" },
  treat: { image: "/images/package-treat.jpg", tag: "Indulgent" },
};

// Same bands and words as the Vibe faders on the trip form.
const band = (v: number) => (v < 0.35 ? 0 : v > 0.65 ? 2 : 1);
const RHYTHM = ["Early starts", "All day", "Late nights"];
const PACE = ["Unhurried pace", "Steady pace", "Packed days"];
const BUDGET = ["Street food & transit", "Mid-range", "Tasting menus & cabs"];

export function PackageCard({
  id,
  title,
  blurb,
  vibe,
  busy,
  disabled,
  onPlan,
}: {
  id: string;
  title: string;
  blurb: string;
  vibe: VibeConfig;
  busy: boolean;
  disabled: boolean;
  onPlan: () => void;
}) {
  const art = ART[id];
  const rhythm = band(vibe.circadian);
  return (
    <li className="mz-pkg">
      <div className="mz-pkg-media">
        {art && <img className="mz-pkg-img" src={art.image} alt="" loading="lazy" />}
        {art && <span className="mz-pkg-tag">{art.tag}</span>}
        <span className="mz-pkg-chip">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {rhythm === 2 ? (
              <path d="M10.5 2.2a6 6 0 1 0 3.3 8.6A5 5 0 0 1 10.5 2.2Z" />
            ) : (
              <circle cx="8" cy="8" r={rhythm === 0 ? 3.2 : 4.2} />
            )}
          </svg>
          {RHYTHM[rhythm]}
        </span>
      </div>

      <div className="mz-pkg-body">
        <div className="mz-pkg-meta">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5c0 3.4 4.5 8.5 4.5 8.5s4.5-5.1 4.5-8.5A4.5 4.5 0 0 0 8 1.5Zm0 6.2A1.7 1.7 0 1 1 8 4.3a1.7 1.7 0 0 1 0 3.4Z" />
          </svg>
          Any city &middot; {PACE[band(vibe.pacing)]}
        </div>
        <h3 className="mz-pkg-title">{title}</h3>
        <p className="mz-pkg-blurb">{blurb}</p>

        <div className="mz-pkg-foot">
          <div>
            <span className="mz-pkg-foot-label">Budget</span>
            <span className="mz-pkg-foot-value">{BUDGET[band(vibe.budget)]}</span>
          </div>
          <button className="mz-pkg-plan" disabled={disabled} onClick={onPlan}>
            {busy ? "Planning…" : "Plan"}
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.5 7.06 7.06 13.5 6 12.44l6.44-6.44H6.76V4.5H15v8.24h-1.5V7.06Z" />
            </svg>
          </button>
        </div>
      </div>
    </li>
  );
}
