/**
 * Group Vibe Check rooms (USP 5). The trip owner opens a room for a meal slot;
 * the Dining Matcher offers 3 real nearby places; guests join by link (no
 * account), vote yes/no, and a unanimous choice is written into the itinerary
 * under the owner's authority. Single-instance (file store + in-process SSE);
 * Supabase Realtime is the multi-instance path.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { rankMealOptions, noClaimDietChecker } from "@/lib/musafir/dining.ts";
import { estimateLeg } from "@/lib/musafir/geo.ts";
import { consensus, type Vote } from "@/lib/musafir/groupvote.ts";
import { newId } from "@/lib/musafir/ids.ts";
import { applyPatches } from "@/lib/musafir/reducer.ts";
import type { ItineraryNode } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { publish } from "./events.ts";
import { nearbyCandidates } from "./osm.ts";
import { cachedLeg, routedLookup, warmLegs } from "./routing.ts";
import { read, write, type RoomOption, type RoomRecord } from "./store.ts";

const ROOM_TTL_MS = 4 * 60 * 60_000;
const MAX_PARTICIPANTS = 12;
const SEARCH_RADIUS_M = 1200;
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;

const g = globalThis as typeof globalThis & { __musafirRate?: Map<string, { at: number; n: number }> };
const rate = (g.__musafirRate ??= new Map());

/** Simple per-IP limit for unauthenticated room endpoints. */
export function rateLimit(ip: string) {
  const now = Date.now();
  const cur = rate.get(ip);
  if (!cur || now - cur.at > RATE_WINDOW_MS) {
    rate.set(ip, { at: now, n: 1 });
    if (rate.size > 5000) rate.clear();
    return;
  }
  if (++cur.n > RATE_MAX) throw new HttpError(429, "Too many requests — try again in a minute");
}

const expired = (r: RoomRecord) => Date.now() > Date.parse(r.expiresAt);
const findByToken = (rooms: readonly RoomRecord[], token: string) => {
  const r = rooms.find((x) => x.token.length === token.length && timingSafeEqual(Buffer.from(x.token), Buffer.from(token)));
  if (!r) throw new HttpError(404, "This room link isn't valid");
  return r;
};

export async function createRoom(user: SessionUser, tripId: string, dayIndex: number, input: { start: string; durationMinutes: number }) {
  const rec = await read((db) => structuredClone(db.trips.find((t) => t.trip.id === tripId)));
  if (!rec || rec.ownerId !== user.id) throw new HttpError(404, "Trip not found");
  const day = rec.trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day) throw new HttpError(404, "Day not found");
  const startMin = toMinutes(input.start);
  if (startMin + input.durationMinutes > MINUTES_PER_DAY) throw new HttpError(422, "That meal would end after midnight");
  if (day.nodes.length === 0) throw new HttpError(422, "Add or plan some stops first, so we know where you'll be");

  // Where will they be? The stop before the slot (else the first stop); and the one after.
  const before = [...day.nodes].reverse().find((n) => toMinutes(n.timeSlot.start) < startMin) ?? day.nodes[0];
  const after = day.nodes.find((n) => toMinutes(n.timeSlot.start) >= startMin + input.durationMinutes);

  const venues = await nearbyCandidates(before.location, "DINING", SEARCH_RADIUS_M);
  if (venues.length === 0) throw new HttpError(422, `No eateries found near "${before.title}"`);
  const candidates = venues.slice(0, 40).map((v) => ({ id: v.osmId, name: v.nameEn ?? v.name, lat: v.lat, lng: v.lng, diet: v.diet, venue: v }));
  await warmLegs([before.location, ...(after ? [after.location] : []), ...candidates]).catch(() => undefined);
  const minutes = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => cachedLeg(a, b)?.durationMinutes ?? estimateLeg(a, b).durationMinutes;
  const ranked = rankMealOptions(before.location, after?.location, candidates, rec.trip.dietaryRestrictions, minutes, noClaimDietChecker, 3);

  const options: RoomOption[] = ranked.map((o) => ({
    id: o.candidate.id,
    name: o.candidate.name,
    nameNative: o.candidate.venue.nameEn ? o.candidate.venue.name : undefined,
    lat: o.candidate.lat,
    lng: o.candidate.lng,
    kind: o.candidate.venue.kind,
    source: o.candidate.venue.source,
    diet: o.diet === "conflicts" ? "unverified" : o.diet,
    travelMinutes: o.travelMinutes,
  }));
  const now = new Date();
  const room: RoomRecord = {
    id: newId(),
    token: randomBytes(18).toString("base64url"),
    tripId,
    dayIndex,
    ownerId: user.id,
    start: input.start,
    durationMinutes: input.durationMinutes,
    options,
    participants: [{ id: newId(), name: user.name, key: randomBytes(16).toString("hex"), joinedAt: now.toISOString() }],
    votes: {},
    status: "OPEN",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ROOM_TTL_MS).toISOString(),
  };
  await write((db) => {
    db.rooms.push(room);
    db.activity.push({ id: newId(), tripId, at: room.createdAt, actor: `${user.name} (traveller)`, message: `Opened a group vote for ${input.start} (${options.length} options)` });
  });
  publish({ type: "room.changed", tripId, roomId: room.id });
  const owner = room.participants[0];
  return { token: room.token, participantId: owner.id, key: owner.key };
}

/** Public view: never exposes participant keys. */
export async function roomView(token: string) {
  return read((db) => {
    const r = findByToken(db.rooms, token);
    const c = consensus(r.options.map((o) => o.id), r.participants.map((p) => p.id), r.votes);
    return {
      id: r.id,
      tripId: r.tripId,
      destination: db.trips.find((t) => t.trip.id === r.tripId)?.trip.destination ?? "",
      start: r.start,
      durationMinutes: r.durationMinutes,
      options: r.options,
      participants: r.participants.map((p) => ({ id: p.id, name: p.name, voted: Object.keys(r.votes[p.id] ?? {}).length })),
      tally: c.tally,
      state: r.status === "OPEN" ? (expired(r) ? "EXPIRED" : c.state) : r.status,
      winnerOptionId: r.winnerOptionId,
      expiresAt: r.expiresAt,
    };
  });
}

export async function joinRoom(token: string, name: string) {
  const out = await write((db) => {
    const r = findByToken(db.rooms, token);
    if (r.status !== "OPEN" || expired(r)) throw new HttpError(409, "This vote has finished");
    if (r.participants.length >= MAX_PARTICIPANTS) throw new HttpError(409, "This room is full");
    const p = { id: newId(), name, key: randomBytes(16).toString("hex"), joinedAt: new Date().toISOString() };
    r.participants.push(p);
    return { room: r, p };
  });
  publish({ type: "room.changed", tripId: out.room.tripId, roomId: out.room.id });
  return { participantId: out.p.id, key: out.p.key };
}

function writeWinner(db: Parameters<Parameters<typeof write>[0]>[0], r: RoomRecord, optionId: string, how: string) {
  const option = r.options.find((o) => o.id === optionId);
  const rec = db.trips.find((t) => t.trip.id === r.tripId);
  const day = rec?.trip.schedule.find((d) => d.dayIndex === r.dayIndex);
  if (!option || !rec || !day) throw new HttpError(409, "The trip changed; this room can't be applied");
  const node: ItineraryNode = {
    id: newId(),
    type: "SOFT",
    title: option.name,
    nativeTitle: option.nameNative,
    category: "DINING",
    location: { lat: option.lat, lng: option.lng, city: day.nodes[0]?.location.city ?? rec.trip.destination },
    timeSlot: { start: r.start, durationMinutes: r.durationMinutes, bufferMinutes: 15 },
    isOutdoor: false,
    costEstimate: { amount: 0, currency: day.nodes[0]?.costEstimate.currency ?? "USD" },
    metadata: { source: option.source, osmId: option.id, kind: option.kind, plannedBy: "group vote", costSource: "unknown (no price in open data)", ...(option.diet !== "not-needed" ? { diet: option.diet } : {}) },
  };
  const next = applyPatches(day, [{ patchId: newId(), targetDayIndex: r.dayIndex, operation: "INSERT", payload: node, reason: `Group chose "${option.name}"` }], { routed: routedLookup });
  rec.trip.schedule = rec.trip.schedule.map((d) => (d.dayIndex === r.dayIndex ? next : d));
  rec.trip.version += 1;
  rec.updatedAt = new Date().toISOString();
  r.status = "DECIDED";
  r.winnerOptionId = option.id;
  db.activity.push({ id: newId(), tripId: r.tripId, at: rec.updatedAt, actor: "group vote", message: `${how}: ${option.name} at ${r.start}` });
  return rec.trip.version;
}

export async function castVote(token: string, participantId: string, key: string, optionId: string, vote: Vote) {
  const out = await write((db) => {
    const r = findByToken(db.rooms, token);
    if (r.status !== "OPEN" || expired(r)) throw new HttpError(409, "This vote has finished");
    const p = r.participants.find((x) => x.id === participantId);
    if (!p || p.key.length !== key.length || !timingSafeEqual(Buffer.from(p.key), Buffer.from(key))) throw new HttpError(403, "Rejoin the room to vote");
    if (!r.options.some((o) => o.id === optionId)) throw new HttpError(400, "Unknown option");
    r.votes[participantId] = { ...r.votes[participantId], [optionId]: vote };
    const c = consensus(r.options.map((o) => o.id), r.participants.map((x) => x.id), r.votes);
    const version = c.state === "WIN" ? writeWinner(db, r, c.optionId, "Everyone agreed") : null;
    return { r, version };
  });
  publish({ type: "room.changed", tripId: out.r.tripId, roomId: out.r.id });
  if (out.version !== null) publish({ type: "trip.updated", tripId: out.r.tripId, version: out.version });
}

/** Owner picks after a deadlock (or early). */
export async function ownerDecide(user: SessionUser, token: string, optionId: string) {
  const out = await write((db) => {
    const r = findByToken(db.rooms, token);
    if (r.ownerId !== user.id) throw new HttpError(403, "Only the trip owner can decide");
    if (r.status !== "OPEN") throw new HttpError(409, "This vote has finished");
    return { r, version: writeWinner(db, r, optionId, "Organiser chose") };
  });
  publish({ type: "room.changed", tripId: out.r.tripId, roomId: out.r.id });
  publish({ type: "trip.updated", tripId: out.r.tripId, version: out.version });
}

export async function roomsForTrip(user: SessionUser, tripId: string) {
  return read((db) =>
    db.rooms
      .filter((r) => r.tripId === tripId && r.ownerId === user.id)
      .slice(-5)
      .reverse()
      .map((r) => ({ token: r.token, start: r.start, dayIndex: r.dayIndex, status: r.status === "OPEN" && expired(r) ? "EXPIRED" : r.status, winner: r.options.find((o) => o.id === r.winnerOptionId)?.name })),
  );
}

export const slotLabel = (r: { start: string; durationMinutes: number }) => `${r.start}–${fromMinutes(Math.min(MINUTES_PER_DAY - 1, toMinutes(r.start) + r.durationMinutes))}`;
