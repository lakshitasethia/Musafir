import type { VibeConfig } from "@/lib/musafir/schemas.ts";

/**
 * A package as an editorial card: photo with its style tag, serif title,
 * blurb, a short spec list (pace, hours, budget) and a Plan button.
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
const PACE = ["Unhurried", "Steady", "Packed days"];
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
  const specs: [string, string][] = [
    ["Pace", PACE[band(vibe.pacing)]],
    ["Hours", RHYTHM[band(vibe.circadian)]],
    ["Budget", BUDGET[band(vibe.budget)]],
  ];
  return (
    <li className="mz-pkg">
      <div className="mz-pkg-media">
        {art && <img className="mz-pkg-img" src={art.image} alt="" loading="lazy" />}
        {art && <span className="mz-pkg-tag">{art.tag}</span>}
      </div>

      <div className="mz-pkg-body">
        <h3 className="mz-pkg-title">{title}</h3>
        <p className="mz-pkg-blurb">{blurb}</p>

        <dl className="mz-pkg-specs">
          {specs.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <button className="mz-pkg-plan" disabled={disabled} onClick={onPlan}>
          {busy ? "Planning…" : "Plan this style"}
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13.5 7.06 7.06 13.5 6 12.44l6.44-6.44H6.76V4.5H15v8.24h-1.5V7.06Z" />
          </svg>
        </button>
      </div>
    </li>
  );
}
