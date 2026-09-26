"use client";

/**
 * Commute map (USP 3). MapLibre + OpenFreeMap "positron" tiles (free, no key;
 * attribution is added by the style). Stops are numbered markers; legs are
 * coloured by commute band. Legs are drawn as straight lines between stops —
 * the minutes come from OSRM or estimates, but we have no road geometry, and
 * the legend says so. Tapping a red (spike) leg asks for "Cluster Nearby".
 *
 * Load this with next/dynamic({ ssr: false }): it touches `window` at import.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, setWorkerUrl } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { commuteBand, type CommuteBand } from "@/lib/musafir/geo.ts";
import type { DaySchedule } from "@/lib/musafir/schemas.ts";

export const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
// MapLibre's module worker + shared chunk are served by src/app/maplibre/[file]/route.ts.
setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.origin).toString());

function webglAvailable(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const BAND_HEX: Record<CommuteBand, string> = { HEALTHY: "#5e8b72", MODERATE: "#c98a45", SPIKE: "#b8534f" };

function legsGeoJSON(day: DaySchedule) {
  const byPair = new Map(day.transitSegments.map((s) => [`${s.fromNodeId}>${s.toNodeId}`, s]));
  return {
    type: "FeatureCollection" as const,
    features: day.nodes.slice(1).flatMap((to, i) => {
      const from = day.nodes[i];
      const seg = byPair.get(`${from.id}>${to.id}`);
      if (!seg) return [];
      const band = commuteBand(seg.durationMinutes);
      return [
        {
          type: "Feature" as const,
          properties: { toId: to.id, color: BAND_HEX[band], spike: band === "SPIKE", label: `${seg.durationMinutes} min` },
          geometry: { type: "LineString" as const, coordinates: [[from.location.lng, from.location.lat], [to.location.lng, to.location.lat]] },
        },
      ];
    }),
  };
}

export function CommuteMap({ day, onCluster }: { day: DaySchedule; onCluster?: (nodeId: string) => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const clusterRef = useRef(onCluster);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState<string | null>(() => (webglAvailable() ? null : "WebGL is unavailable on this device"));

  useEffect(() => {
    clusterRef.current = onCluster;
  }, [onCluster]);

  useEffect(() => {
    if (!boxRef.current || failed) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container: boxRef.current, style: MAP_STYLE_URL, center: [0, 20], zoom: 1.5 });
    } catch (e) {
      const message = (e as Error).message || "the map couldn't start";
      queueMicrotask(() => setFailed(message));
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("error", (e) => {
      if (!map.isStyleLoaded()) setFailed(e.error?.message ?? "Map tiles couldn't load");
    });
    map.on("load", () => {
      map.addSource("legs", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "legs",
        type: "line",
        source: "legs",
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["case", ["get", "spike"], 5, 3], "line-dasharray": [2, 1.5] },
      });
      map.on("click", "legs", (e) => {
        const f = e.features?.[0];
        if (f?.properties?.spike && clusterRef.current) clusterRef.current(String(f.properties.toId));
      });
      map.on("mouseenter", "legs", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "legs", () => (map.getCanvas().style.cursor = ""));
      setReady(true);
    });
    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- create the map once
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const src = map.getSource("legs") as { setData?: (d: unknown) => void } | undefined;
    src?.setData?.(legsGeoJSON(day));
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = day.nodes.map((n, i) => {
      const el = document.createElement("div");
      el.className = `mz-map-marker${n.type === "HARD" ? " is-hard" : ""}`;
      el.textContent = String(i + 1);
      el.title = `${n.timeSlot.start} · ${n.title}`;
      return new Marker({ element: el }).setLngLat([n.location.lng, n.location.lat]).addTo(map);
    });
    if (day.nodes.length > 0) {
      const b = new LngLatBounds();
      day.nodes.forEach((n) => b.extend([n.location.lng, n.location.lat]));
      map.fitBounds(b, { padding: 48, maxZoom: 15, duration: 600 });
    }
  }, [day, ready]);

  if (failed) return <div className="mz-empty">Map unavailable: {failed}. The journey view has the same information.</div>;
  return (
    <div className="mz-map-wrap">
      <div ref={boxRef} className="mz-map" role="region" aria-label="Commute map" />
      <p className="mz-tiny mz-muted" style={{ margin: "8px 0 0" }}>
        Lines connect stops directly (not the road route). Colours use travel time: green &lt; 15 min, amber 15–35, red &gt; 35 — tap a red line to find a closer option.
      </p>
    </div>
  );
}
