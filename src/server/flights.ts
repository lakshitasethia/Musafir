/**
 * Live flight status from The OpenSky Network (free, anonymous). Anonymous
 * limits (checked 2026-09-26): only current state vectors, 10 s resolution,
 * 400 credits/day; a global /states/all costs 4 credits. So the global snapshot
 * is cached for 60 s and shared by every lookup. We never sell or invent fares:
 * booking is a hand-off to a search engine.
 */
const SNAPSHOT_TTL_MS = 60_000;

interface Snapshot {
  at: number;
  time: number;
  states: unknown[][];
}
const g = globalThis as typeof globalThis & { __musafirOpenSky?: { snap: Snapshot | null; inflight: Promise<Snapshot> | null } };
const state = (g.__musafirOpenSky ??= { snap: null, inflight: null });

async function snapshot(): Promise<Snapshot> {
  if (state.snap && Date.now() - state.snap.at < SNAPSHOT_TTL_MS) return state.snap;
  state.inflight ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch("https://opensky-network.org/api/states/all", { signal: controller.signal });
      if (res.status === 429) throw new Error("OpenSky's free daily limit is used up — try again later");
      if (!res.ok) throw new Error(`OpenSky HTTP ${res.status}`);
      const body = (await res.json()) as { time: number; states: unknown[][] | null };
      state.snap = { at: Date.now(), time: body.time, states: body.states ?? [] };
      return state.snap;
    } finally {
      clearTimeout(timer);
      state.inflight = null;
    }
  })();
  return state.inflight;
}

export interface FlightStatus {
  callsign: string;
  icao24: string;
  originCountry: string;
  lat: number | null;
  lng: number | null;
  altitudeM: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  onGround: boolean;
  lastContact: string;
  observedAt: string;
}

/** Callsign as broadcast by the transponder (e.g. "AIC101", "IGO6E2"), case-insensitive. */
export async function trackFlight(callsign: string): Promise<FlightStatus | null> {
  const want = callsign.replace(/\s+/g, "").toUpperCase();
  const snap = await snapshot();
  // State vector indices per OpenSky docs: 0 icao24, 1 callsign, 2 origin_country, 4 last_contact,
  // 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity (m/s), 10 true_track.
  const row = snap.states.find((s) => typeof s[1] === "string" && (s[1] as string).trim().toUpperCase() === want);
  if (!row) return null;
  const n = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    callsign: String(row[1]).trim(),
    icao24: String(row[0]),
    originCountry: String(row[2]),
    lat: n(row[6]),
    lng: n(row[5]),
    altitudeM: n(row[7]) === null ? null : Math.round(n(row[7])!),
    speedKmh: n(row[9]) === null ? null : Math.round(n(row[9])! * 3.6),
    headingDeg: n(row[10]) === null ? null : Math.round(n(row[10])!),
    onGround: row[8] === true,
    lastContact: new Date(Number(row[4]) * 1000).toISOString(),
    observedAt: new Date(snap.time * 1000).toISOString(),
  };
}
