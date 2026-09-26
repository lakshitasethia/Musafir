"use client";

import { useState } from "react";
import { newId } from "@/lib/musafir/ids.ts";
import { NodeCategorySchema, type ItineraryNode, type NodeCategory } from "@/lib/musafir/schemas.ts";
import { fromMinutes, toMinutes } from "@/lib/musafir/time.ts";
import { api } from "./api";

interface Place {
  displayName: string;
  name: string;
  nativeName?: string;
  lat: number;
  lng: number;
  city: string;
  neighborhood?: string;
  category: NodeCategory;
  isOutdoor: boolean;
}

interface Props {
  node: ItineraryNode | null; // null = create
  role: "traveller" | "operator";
  defaultStart: string;
  near?: { lat: number; lng: number };
  destination: string;
  onClose: () => void;
  onSave: (node: ItineraryNode, isNew: boolean) => Promise<void>;
  onDelete: (node: ItineraryNode) => Promise<void>;
}

export function NodeSheet({ node, role, defaultStart, near, destination, onClose, onSave, onDelete }: Props) {
  const readOnly = !!node && node.type === "HARD" && role !== "operator";
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(() => ({
    title: node?.title ?? "",
    nativeTitle: node?.nativeTitle ?? "",
    nativeAddress: node?.nativeAddress ?? "",
    category: node?.category ?? ("CULTURE" as NodeCategory),
    type: node?.type ?? ("SOFT" as "SOFT" | "HARD"),
    lat: node ? String(node.location.lat) : "",
    lng: node ? String(node.location.lng) : "",
    city: node?.location.city ?? "",
    neighborhood: node?.location.neighborhood ?? "",
    start: node?.timeSlot.start ?? defaultStart,
    duration: String(node?.timeSlot.durationMinutes ?? 60),
    buffer: String(node?.timeSlot.bufferMinutes ?? 15),
    isOutdoor: node?.isOutdoor ?? false,
    cost: String(node?.costEstimate.amount ?? 0),
    currency: node?.costEstimate.currency ?? "USD",
    priority: typeof node?.metadata?.priority === "number" ? (node.metadata.priority as number) : 0.5,
  }));
  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => setDraft((d) => ({ ...d, [k]: v }));

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setError(null);
    try {
      const params = new URLSearchParams({ q: near ? q : `${q} ${destination}` });
      if (near) {
        params.set("lat", String(near.lat));
        params.set("lng", String(near.lng));
      }
      const { results } = await api<{ results: Place[] }>(`/api/places?${params}`);
      setResults(results);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSearching(false);
    }
  }

  function pick(p: Place) {
    setDraft((d) => ({
      ...d,
      title: p.name,
      nativeTitle: p.nativeName ?? "",
      category: p.category,
      isOutdoor: p.isOutdoor,
      lat: String(p.lat),
      lng: String(p.lng),
      city: p.city || destination,
      neighborhood: p.neighborhood ?? "",
    }));
  }

  function build(): ItineraryNode | string {
    const lat = Number(draft.lat);
    const lng = Number(draft.lng);
    const duration = Number(draft.duration);
    const buffer = Number(draft.buffer);
    const cost = Number(draft.cost);
    if (!draft.title.trim()) return "Give the stop a name";
    if (draft.lat === "" || draft.lng === "" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return "Pick a place from search (or enter valid coordinates)";
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.start)) return "Start time must be HH:MM";
    if (!Number.isInteger(duration) || duration < 5) return "Duration must be at least 5 minutes";
    if (toMinutes(draft.start) + duration > 24 * 60) return `That would end after midnight (latest start ${fromMinutes(24 * 60 - duration)})`;
    if (!Number.isInteger(buffer) || buffer < 0 || buffer >= duration) return "Buffer must be between 0 and the duration";
    if (!Number.isFinite(cost) || cost < 0) return "Cost can't be negative";
    if (!/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())) return "Currency must be a 3-letter code";
    return {
      id: node?.id ?? newId(),
      type: role === "operator" ? draft.type : node?.type ?? "SOFT",
      title: draft.title.trim(),
      nativeTitle: draft.nativeTitle.trim() || undefined,
      nativeAddress: draft.nativeAddress.trim() || undefined,
      category: draft.category,
      location: { lat, lng, city: draft.city.trim() || destination, neighborhood: draft.neighborhood.trim() || undefined },
      timeSlot: { start: draft.start, durationMinutes: duration, bufferMinutes: buffer },
      isOutdoor: draft.isOutdoor,
      costEstimate: { amount: cost, currency: draft.currency.trim().toUpperCase() },
      metadata: { ...(node?.metadata ?? {}), priority: draft.priority },
    };
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const n = build();
    if (typeof n === "string") return setError(n);
    setBusy(true);
    try {
      await onSave(n, !node);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mz-sheet-backdrop" onClick={onClose}>
      <div className="mz-sheet" role="dialog" aria-modal="true" aria-label={node ? `Edit ${node.title}` : "Add a stop"} onClick={(e) => e.stopPropagation()}>
        <div className="mz-spread">
          <h2 className="mz-display mz-h2">{node ? node.title : "Add a stop"}</h2>
          <button className="mz-btn mz-btn-ghost mz-btn-sm" onClick={onClose} type="button">
            Close
          </button>
        </div>

        {readOnly ? (
          <div className="mz-stack">
            <p className="mz-note">This is a locked booking managed by your operator. Report a delay or closure from the simulator and they&apos;ll handle it.</p>
            <p className="mz-small">
              {node.timeSlot.start} · {node.timeSlot.durationMinutes} min · {node.location.city}
              {node.nativeTitle ? ` · ${node.nativeTitle}` : ""}
            </p>
          </div>
        ) : (
          <>
            <form className="mz-stack" onSubmit={search}>
              <label className="mz-field">
                <span className="mz-label">Find a place (OpenStreetMap)</span>
                <div className="mz-row" style={{ flexWrap: "nowrap" }}>
                  <input className="mz-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`e.g. museum, café, fort in ${destination}`} enterKeyHint="search" />
                  <button className="mz-btn mz-btn-sm" disabled={searching || query.trim().length < 2}>
                    {searching ? "…" : "Search"}
                  </button>
                </div>
              </label>
              {results && (
                <div className="mz-results">
                  {results.length === 0 && <p className="mz-small mz-muted">No matches. Try another name.</p>}
                  {results.map((r) => (
                    <button key={`${r.lat},${r.lng},${r.name}`} type="button" className="mz-result" aria-pressed={draft.lat === String(r.lat) && draft.title === r.name} onClick={() => pick(r)}>
                      <div>{r.name}</div>
                      <div className="mz-tiny mz-muted">{r.displayName}</div>
                    </button>
                  ))}
                </div>
              )}
            </form>

            <form className="mz-stack" onSubmit={save}>
              <label className="mz-field">
                <span className="mz-label">Name</span>
                <input className="mz-input" value={draft.title} onChange={(e) => set("title", e.target.value)} required />
              </label>
              <div className="mz-grid-2">
                <label className="mz-field">
                  <span className="mz-label">Local-script name</span>
                  <input className="mz-input" value={draft.nativeTitle} onChange={(e) => set("nativeTitle", e.target.value)} />
                </label>
                <label className="mz-field">
                  <span className="mz-label">Category</span>
                  <select className="mz-select" value={draft.category} onChange={(e) => set("category", e.target.value as NodeCategory)}>
                    {NodeCategorySchema.options.map((c) => (
                      <option key={c} value={c}>
                        {c.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mz-grid-3">
                <label className="mz-field">
                  <span className="mz-label">Start</span>
                  <input className="mz-input" type="time" step={300} value={draft.start} onChange={(e) => set("start", e.target.value)} required />
                </label>
                <label className="mz-field">
                  <span className="mz-label">Minutes</span>
                  <input className="mz-input" type="number" inputMode="numeric" min={5} max={1440} value={draft.duration} onChange={(e) => set("duration", e.target.value)} />
                </label>
                <label className="mz-field">
                  <span className="mz-label">Can shorten by</span>
                  <input className="mz-input" type="number" inputMode="numeric" min={0} value={draft.buffer} onChange={(e) => set("buffer", e.target.value)} />
                </label>
              </div>
              <div className="mz-fader">
                <span className="mz-label">How much this stop matters</span>
                <input type="range" min={0} max={1} step={0.05} value={draft.priority} onChange={(e) => set("priority", Number(e.target.value))} aria-label="Priority" />
                <div className="mz-fader-ends">
                  <span>Skip first if short on time</span>
                  <span>Protect it</span>
                </div>
              </div>
              <div className="mz-grid-2">
                <label className="mz-field">
                  <span className="mz-label">Est. cost</span>
                  <input className="mz-input" type="number" inputMode="decimal" min={0} step="any" value={draft.cost} onChange={(e) => set("cost", e.target.value)} />
                </label>
                <label className="mz-field">
                  <span className="mz-label">Currency</span>
                  <input className="mz-input" value={draft.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
                </label>
              </div>
              <label className="mz-check">
                <input type="checkbox" checked={draft.isOutdoor} onChange={(e) => set("isOutdoor", e.target.checked)} />
                <span>Outdoors (rain-sensitive)</span>
              </label>
              {role === "operator" && (
                <label className="mz-check">
                  <input type="checkbox" checked={draft.type === "HARD"} onChange={(e) => set("type", e.target.checked ? "HARD" : "SOFT")} />
                  <span>Locked booking (never moved by the engine)</span>
                </label>
              )}
              <details>
                <summary className="mz-label" style={{ cursor: "pointer", minHeight: 32 }}>
                  Location details
                </summary>
                <div className="mz-grid-2" style={{ marginTop: 8 }}>
                  <label className="mz-field">
                    <span className="mz-label">Latitude</span>
                    <input className="mz-input" inputMode="decimal" value={draft.lat} onChange={(e) => set("lat", e.target.value)} />
                  </label>
                  <label className="mz-field">
                    <span className="mz-label">Longitude</span>
                    <input className="mz-input" inputMode="decimal" value={draft.lng} onChange={(e) => set("lng", e.target.value)} />
                  </label>
                  <label className="mz-field">
                    <span className="mz-label">City</span>
                    <input className="mz-input" value={draft.city} onChange={(e) => set("city", e.target.value)} />
                  </label>
                  <label className="mz-field">
                    <span className="mz-label">Local-script address</span>
                    <input className="mz-input" value={draft.nativeAddress} onChange={(e) => set("nativeAddress", e.target.value)} />
                  </label>
                </div>
              </details>
              {error && <p className="mz-error">{error}</p>}
              <div className="mz-spread">
                {node ? (
                  <button
                    type="button"
                    className="mz-btn mz-btn-danger"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onDelete(node);
                        onClose();
                      } catch (err) {
                        setError((err as Error).message);
                        setBusy(false);
                      }
                    }}
                  >
                    Delete
                  </button>
                ) : (
                  <span />
                )}
                <button className="mz-btn mz-btn-solid" disabled={busy}>
                  {busy ? "Saving…" : node ? "Save changes" : "Add to day"}
                </button>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
