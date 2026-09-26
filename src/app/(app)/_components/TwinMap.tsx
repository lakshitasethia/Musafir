"use client";

/**
 * Digital Twin map (MapLibre + OpenFreeMap tiles, same setup as CommuteMap).
 * Draws what the twin knows: places coloured by simulated risk, a rain field
 * sized by the forecast/scenario, cascade lines (a disruption at one stop
 * pushing or dropping others), social-signal pins and fleet hotspots.
 * Load with next/dynamic({ ssr: false }).
 */
import "maplibre-gl/dist/maplibre-gl.css";
import { LngLatBounds, Map as MapLibreMap, Marker, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";

setWorkerUrl(new URL("/maplibre/maplibre-gl-worker.mjs", window.location.origin).toString());
const STYLE = "https://tiles.openfreemap.org/styles/positron";

export interface TwinPoint {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** 0..1 risk (stops/trips) or relative weight (hotspots). */
  value: number;
  kind: "stop" | "trip" | "hotspot" | "social";
  detail?: string;
  locked?: boolean;
}
export interface TwinLine {
  from: [number, number]; // [lng, lat]
  to: [number, number];
  kind: "delays" | "drops" | "route";
  weight: number;
}
export interface TwinRain {
  lat: number;
  lng: number;
  /** Peak mm/h in the (scenario) weather. */
  mm: number;
  label: string;
}

const riskColor = (v: number) => (v >= 0.5 ? "#b8534f" : v >= 0.2 ? "#c98a45" : "#5e8b72");

function webgl() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export function TwinMap({ points, lines = [], rain = [], height = 360 }: { points: TwinPoint[]; lines?: TwinLine[]; rain?: TwinRain[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markers = useRef<Marker[]>([]);
  const [styled, setStyled] = useState(false);
  const [failed, setFailed] = useState<string | null>(() => (webgl() ? null : "WebGL is unavailable on this device"));
  const fitted = useRef("");

  useEffect(() => {
    if (!box.current || failed) return;
    let map: MapLibreMap;
    try {
      map = new MapLibreMap({ container: box.current, style: STYLE, center: [78, 22], zoom: 3, cooperativeGestures: true });
    } catch (e) {
      queueMicrotask(() => setFailed((e as Error).message || "the map couldn't start"));
      return;
    }
    mapRef.current = map;
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("twin-rain", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "twin-rain",
        type: "circle",
        source: "twin-rain",
        paint: {
          // Radius grows with rain intensity; zoom-scaled so it reads as an area.
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, ["*", 6, ["get", "r"]], 14, ["*", 60, ["get", "r"]]],
          "circle-color": "#4b6b94",
          "circle-opacity": ["min", 0.45, ["*", 0.08, ["get", "r"]]],
          "circle-blur": 0.6,
        },
      });
      map.addSource("twin-lines", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: "twin-lines",
        type: "line",
        source: "twin-lines",
        paint: {
          "line-color": ["match", ["get", "kind"], "drops", "#b8534f", "delays", "#c98a45", "#3d2d20"],
          "line-width": ["min", 6, ["+", 1.5, ["get", "w"]]],
          "line-dasharray": [2, 1.5],
          "line-opacity": 0.8,
        },
      });
      setStyled(true);
    });
    return () => {
      markers.current.forEach((m) => m.remove());
      markers.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [failed]);

  // Markers (HTML) — work before the style finishes loading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markers.current.forEach((m) => m.remove());
    markers.current = points.map((p) => {
      const el = document.createElement("div");
      el.className = `mz-twin-pin is-${p.kind}`;
      el.style.setProperty("--pin", p.kind === "social" ? "#4b6b94" : p.kind === "hotspot" ? "#b8534f" : riskColor(p.value));
      el.textContent = p.kind === "stop" ? `${Math.round(p.value * 100)}` : p.kind === "social" ? "✦" : p.kind === "hotspot" ? `${p.value}` : `${Math.round(p.value * 100)}`;
      el.title = p.label;
      el.setAttribute("aria-label", `${p.label}${p.detail ? `: ${p.detail}` : ""}`);
      if (p.locked) el.dataset.locked = "true";
      const popup = new Popup({ offset: 14, closeButton: false }).setText(`${p.label}${p.detail ? ` — ${p.detail}` : ""}`);
      return new Marker({ element: el }).setLngLat([p.lng, p.lat]).setPopup(popup).addTo(map);
    });
    const key = points.map((p) => p.id).join("|");
    if (points.length && fitted.current !== key) {
      fitted.current = key;
      const b = new LngLatBounds();
      points.forEach((p) => b.extend([p.lng, p.lat]));
      map.fitBounds(b, { padding: 48, maxZoom: 14, duration: 0 });
    }
  }, [points]);

  // Rain field + cascade lines need the style.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styled) return;
    (map.getSource("twin-rain") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: rain.map((r) => ({ type: "Feature", properties: { r: Math.min(8, Math.sqrt(Math.max(0, r.mm)) + (r.mm > 0 ? 1 : 0)), label: r.label }, geometry: { type: "Point", coordinates: [r.lng, r.lat] } })),
    });
    (map.getSource("twin-lines") as GeoJSONSource | undefined)?.setData({
      type: "FeatureCollection",
      features: lines.map((l) => ({ type: "Feature", properties: { kind: l.kind, w: l.weight }, geometry: { type: "LineString", coordinates: [l.from, l.to] } })),
    });
  }, [rain, lines, styled]);

  if (failed) return <p className="mz-note">Map unavailable: {failed}. The twin figures below still apply.</p>;
  return <div ref={box} className="mz-twin-map" style={{ height }} role="region" aria-label="Digital twin map" />;
}
