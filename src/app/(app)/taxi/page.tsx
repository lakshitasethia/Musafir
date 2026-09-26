"use client";

/**
 * Taxi Rescue card (USP 4). Works with zero signal: the page shell is cached
 * by the service worker and the trip comes from the device's IndexedDB copy.
 * Shows the stop in its local script, big enough to read through a taxi
 * partition. Online, it fetches the local-script address once and saves it.
 * No server gate here on purpose — data never leaves the device's own copy.
 */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import type { ItineraryNode } from "@/lib/musafir/schemas.ts";
import type { TripBundle } from "@/server/trips.ts";
import { api } from "../_components/api";
import { loadBundle, saveBundle, type SavedBundle } from "../_components/offlineStore";
import { TaxiCard } from "../_ui/TaxiCard";

function TaxiScreen() {
  const params = useSearchParams();
  const tripId = params.get("trip") ?? "";
  const stopId = params.get("stop") ?? "";
  const [saved, setSaved] = useState<SavedBundle<TripBundle> | null | undefined>(undefined);
  const [address, setAddress] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadBundle<TripBundle>(tripId).then((s) => !cancelled && setSaved(s));
    return () => {
      cancelled = true;
    };
  }, [tripId]);

  const nodes = saved?.bundle.trip.schedule.flatMap((d) => d.nodes.map((n) => ({ n, dayIndex: d.dayIndex }))) ?? [];
  const found = nodes.find((x) => x.n.id === stopId) ?? nodes[0];
  const node: ItineraryNode | undefined = found?.n;
  const shownAddress = node?.nativeAddress ?? address;

  // Online and no local-script address yet: look it up once, keep it on the device, and try to save it to the trip.
  useEffect(() => {
    if (!node || node.nativeAddress || !navigator.onLine || !saved) return;
    let cancelled = false;
    api<{ place: { localAddress: string } | null }>(`/api/places/reverse?lat=${node.location.lat}&lng=${node.location.lng}`)
      .then(async ({ place }) => {
        if (cancelled || !place) return;
        setAddress(place.localAddress);
        const updated = structuredClone(saved.bundle);
        updated.trip.schedule.forEach((d) => d.nodes.forEach((n) => n.id === node.id && (n.nativeAddress = place.localAddress)));
        await saveBundle(tripId, updated);
        if (node.type === "SOFT") {
          await api(`/api/trips/${tripId}/days/${found!.dayIndex}/patches`, {
            body: {
              baseVersion: saved.bundle.trip.version,
              patches: [{ patchId: crypto.randomUUID(), targetDayIndex: found!.dayIndex, operation: "REPLACE", nodeId: node.id, payload: { ...node, nativeAddress: place.localAddress }, reason: `Saved local address for "${node.title}"` }],
            },
          }).catch(() => undefined); // not the owner / plan changed: the device copy still has it
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [node, saved, tripId, found]);

  if (saved === undefined) return <p className="mz-muted" style={{ padding: 24 }}>Opening your saved trip…</p>;
  if (!saved || !node) {
    return (
      <div className="mz-empty" style={{ margin: 24 }}>
        This trip isn&apos;t saved on this device yet. Open it once while online and the card will work offline.
      </div>
    );
  }
  return (
    <main className="mz-shell mz-stack" style={{ paddingTop: 16 }}>
      <div className="mz-spread">
        <span className="mz-row">
          <Link href="/" className="mz-label">
            Home
          </Link>
          <Link href={`/trip/${tripId}`} className="mz-label">
            ← Trip
          </Link>
        </span>
        <span className="mz-label">Show this to your driver</span>
      </div>
      <TaxiCard node={{ ...node, nativeAddress: shownAddress ?? undefined }} />
      <div className="mz-row">
        <a className="mz-btn mz-btn-sm" href={`geo:${node.location.lat},${node.location.lng}?q=${node.location.lat},${node.location.lng}`}>
          Open in maps
        </a>
      </div>
      <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
        Saved on this device {new Date(saved.savedAt).toLocaleString()} — works without signal.
        {!shownAddress ? " The local address appears after one online visit." : ""}
      </p>
      {nodes.length > 1 && (
        <nav aria-label="Other stops" className="mz-row">
          {nodes.map(({ n }) => (
            <Link key={n.id} href={`/taxi?trip=${tripId}&stop=${n.id}`} className="mz-chip" aria-pressed={n.id === node.id}>
              {n.timeSlot.start} {n.title}
            </Link>
          ))}
        </nav>
      )}
    </main>
  );
}

export default function TaxiPage() {
  return (
    <Suspense fallback={<p className="mz-muted" style={{ padding: 24 }}>Loading…</p>}>
      <TaxiScreen />
    </Suspense>
  );
}
