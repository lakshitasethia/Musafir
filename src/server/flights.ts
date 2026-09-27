/**
 * Live flight status from The OpenSky Network (free). Anonymous: 400 credits/day;
 * with an API client (OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET, OAuth2 client
 * credentials — checked 2026-09-27) 4,000/day. A global /states/all costs 4 credits. So the global snapshot
 * is cached for 60 s and shared by every lookup. We never sell or invent fares:
 * booking is a hand-off to a search engine.
 */
import { cached } from "./osm.ts";

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

// ── Ticket flight numbers → radio callsigns ─────────────────────────
// Tickets show the airline's IATA code (6E 964, AI 101); aircraft broadcast the ICAO code
// (IGO964, AIC101). The mapping comes from OpenFlights' public airline dataset (cached a week).
const AIRLINES_URL = "https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat";
interface Airline {
  name: string;
  iata: string;
  icao: string;
  active: boolean;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((v) => (v === "\\N" ? "" : v.trim()));
}

async function airlines(): Promise<Airline[]> {
  return cached("openflights:airlines:v1", async () => {
    const res = await fetch(AIRLINES_URL, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`airline list HTTP ${res.status}`);
    return (await res.text())
      .split("\n")
      .map(parseCsvLine)
      .filter((f) => f.length >= 8 && /^[A-Z]{3}$/.test(f[4]))
      .map((f) => ({ name: f[1], iata: f[3].toUpperCase(), icao: f[4].toUpperCase(), active: f[7] === "Y" }));
  });
}

export interface CallsignGuess {
  callsign: string;
  airline?: string;
}

/** "6E 964" → IGO964 (IndiGo); "AIC101" stays; unknown codes are searched as typed. */
export async function callsignsFor(query: string): Promise<CallsignGuess[]> {
  const q = query.replace(/[\s-]+/g, "").toUpperCase();
  const list = await airlines().catch(() => [] as Airline[]);
  const icao = /^([A-Z]{3})(\d{1,4}[A-Z]{0,2})$/.exec(q);
  if (icao) {
    const a = list.find((x) => x.icao === icao[1]);
    return [{ callsign: q, airline: a?.name }];
  }
  const iata = /^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/.exec(q);
  if (iata) {
    const num = iata[2].replace(/^0+(?=\d)/, "");
    const matches = list.filter((x) => x.iata === iata[1]).sort((a, b) => Number(b.active) - Number(a.active));
    const guesses = matches.slice(0, 3).flatMap((a) => [...new Set([`${a.icao}${num}`, `${a.icao}${iata[2]}`])].map((callsign) => ({ callsign, airline: a.name })));
    if (guesses.length) return guesses;
  }
  return [{ callsign: q }];
}

/** Live position for a ticket flight number ("6E 964") or radio callsign ("IGO964"). */
export async function trackFlight(query: string): Promise<{ status: FlightStatus | null; searched: CallsignGuess[] }> {
  const searched = await callsignsFor(query);
  const wanted = new Set(searched.map((g) => g.callsign));
  const snap = await snapshot();
  // State vector indices per OpenSky docs: 0 icao24, 1 callsign, 2 origin_country, 4 last_contact,
  // 5 longitude, 6 latitude, 7 baro_altitude, 8 on_ground, 9 velocity (m/s), 10 true_track.
  const row = snap.states.find((s) => typeof s[1] === "string" && wanted.has((s[1] as string).trim().toUpperCase()));
  if (!row) return { status: null, searched };
  return { status: toStatus(row, snap), searched };
}

function toStatus(row: unknown[], snap: Snapshot): FlightStatus {
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
