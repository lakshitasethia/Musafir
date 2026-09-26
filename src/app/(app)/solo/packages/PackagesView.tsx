"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { VibeConfig } from "@/lib/musafir/schemas.ts";
import { SectionHeader } from "../../_ui/SectionHeader";
import { api } from "../../_components/api";

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Packages ─────────────────────────────────────────────────────────
const PACKAGES: { id: string; title: string; blurb: string; vibe: VibeConfig }[] = [
  { id: "heritage", title: "Heritage & Street Food", blurb: "Forts, museums and landmarks, fuelled by street stalls and cafés.", vibe: { pacing: 0.6, budget: 0.2, culturalDepth: 0.15, circadian: 0.3 } },
  { id: "slow", title: "Slow & Scenic", blurb: "Two or three unhurried stops a day, parks and gardens, long lunches.", vibe: { pacing: 0.1, budget: 0.5, culturalDepth: 0.5, circadian: 0.3 } },
  { id: "local", title: "Local & After Dark", blurb: "Galleries, arts centres and cinemas; starts late, ends later.", vibe: { pacing: 0.5, budget: 0.5, culturalDepth: 0.9, circadian: 0.9 } },
  { id: "marathon", title: "See It All", blurb: "Six stops a day, early starts, the essentials back to back.", vibe: { pacing: 0.95, budget: 0.4, culturalDepth: 0.3, circadian: 0.1 } },
  { id: "treat", title: "Treat Yourself", blurb: "Sit-down restaurants and a relaxed pace between the highlights.", vibe: { pacing: 0.4, budget: 0.95, culturalDepth: 0.4, circadian: 0.6 } },
];

export function PackagesView() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [destination, setDestination] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addDays(today, 2));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function choose(p: (typeof PACKAGES)[number]) {
    if (!destination.trim()) return setErr("Where to? Enter a destination first.");
    setBusy(p.id);
    setErr(null);
    try {
      const { id } = await api<{ id: string }>("/api/trips", { body: { destination: destination.trim(), startDate: start, endDate: end, vibeConfig: p.vibe, autoPlan: true } });
      router.push(`/trip/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="mz-stack">
      <SectionHeader index={1} eyebrow="Packages" title="Pick a way to travel" as="h1" />
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        Each package is a travel style. Choose one and Musafir drafts every day from real places at your destination — then heals the plan when things change. Flights and hotels book separately; no bundled prices.
      </p>
      <div className="mz-panel mz-stack">
        <label className="mz-field">
          <span className="mz-label">Where to?</span>
          <input className="mz-input" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Jaipur, Kyoto, Lisbon…" maxLength={120} />
        </label>
        <div className="mz-grid-2">
          <label className="mz-field">
            <span className="mz-label">From</span>
            <input className="mz-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="mz-field">
            <span className="mz-label">To</span>
            <input className="mz-input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        {err && <p className="mz-error" style={{ margin: 0 }}>{err}</p>}
      </div>
      <ul className="mz-list">
        {PACKAGES.map((p) => (
          <li key={p.id} className="mz-offer mz-list-item" style={{ flexWrap: "wrap" }}>
            <div style={{ minWidth: 0 }}>
              <div className="mz-display mz-h3">{p.title}</div>
              <div className="mz-small mz-muted">{p.blurb}</div>
            </div>
            <button className="mz-btn mz-btn-solid mz-btn-sm" disabled={busy !== null} onClick={() => choose(p)}>
              {busy === p.id ? "Planning…" : "Plan this package"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
