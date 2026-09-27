/**
 * Live flight status from The OpenSky Network (free). Anonymous: 400 credits/day;
 * with an API client (OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET, OAuth2 client
 * credentials — checked 2026-09-27) 4,000/day. A global /states/all costs 4 credits. So the global snapshot
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

const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const auth = ((globalThis as typeof globalThis & { __musafirOpenSkyAuth?: { token: string; exp: number } | null }).__musafirOpenSkyAuth ??= null);
let token: { token: string; exp: number } | null = auth;

/** Bearer token for a registered API client (tokens last 30 min); null → anonymous access. */
async function bearer(force = false): Promise<string | null> {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (!force && token && Date.now() < token.exp) return token.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OpenSky login failed (HTTP ${res.status}) — check OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET`);
  const b = (await res.json()) as { access_token: string; expires_in?: number };
  token = { token: b.access_token, exp: Date.now() + Math.max(60, (b.expires_in ?? 1800) - 60) * 1000 };
  (globalThis as typeof globalThis & { __musafirOpenSkyAuth?: { token: string; exp: number } | null }).__musafirOpenSkyAuth = token;
  return token.token;
}

async function fetchStates(signal: AbortSignal): Promise<Response> {
  const t = await bearer();
  const get = (tok: string | null) => fetch("https://opensky-network.org/api/states/all", { signal, headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  const res = await get(t);
  // An expired token answers 401: log in again once.
  return res.status === 401 && t ? get(await bearer(true)) : res;
}

async function snapshot(): Promise<Snapshot> {
  if (state.snap && Date.now() - state.snap.at < SNAPSHOT_TTL_MS) return state.snap;
  state.inflight ??= (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetchStates(controller.signal);
      if (res.status === 429) {
        throw new Error(process.env.OPENSKY_CLIENT_ID ? "OpenSky's daily limit for this API client is used up — try again later" : "OpenSky's free daily limit is used up — add an OpenSky API client (OPENSKY_CLIENT_ID/SECRET) for 10× more");
      }
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
