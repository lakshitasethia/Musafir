/**
 * Dashboards' graph view. Reads the live trip graph straight from Neo4j
 * (store-neo4j GRAPH_CYPHER) — or derives the same shape from the file store —
 * and returns nodes/edges for the browser. Scoped: travellers see only their
 * own trips; operator-only items (unsent weather advisories, other people's
 * trips) never reach a traveller. Password fields are never selected.
 */
import { newId } from "@/lib/musafir/ids.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { publish } from "./events.ts";
import { activeStorageKind, read, write, type ProposalRecord } from "./store.ts";

export interface GraphNode {
  id: string;
  label: "User" | "Trip" | "Day" | "Stop" | "Proposal";
  title: string;
  sub?: string;
  tripId?: string;
  dayIndex?: number;
  props: Record<string, string | number | boolean | null>;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: "OWNS" | "HAS_DAY" | "HAS_STOP" | "NEXT" | "FOR";
  label?: string;
}
export interface GraphView {
  source: "neo4j" | "file";
  cypher?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { users: number; trips: number; days: number; stops: number; openCards: number; verifiedTrips: number; advisoriesForReview: number };
}

const MAX_TRIPS = { traveller: 20, operator: 30 };
type Row = Record<string, unknown>;

function parseProposal(raw: unknown): Pick<ProposalRecord, "id" | "status" | "headline" | "dayIndex" | "review"> | null {
  try {
    const p = JSON.parse(String(raw)) as ProposalRecord;
    return { id: p.id, status: p.status, headline: p.headline, dayIndex: p.dayIndex, review: p.review };
  } catch {
    return null;
  }
}

function build(rows: Row[], viewer: SessionUser): Omit<GraphView, "source" | "cypher"> {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  let openCards = 0;
  let advisories = 0;
  let verified = 0;
  for (const r of rows) {
    const u = r.u as { id: string; name: string; role: string; guest?: boolean };
    const t = r.t as { id: string; destination: string; dateStart: string; dateEnd: string; verifiedJson?: string; version?: number };
    const uid = `user:${u.id}`;
    nodes.set(uid, { id: uid, label: "User", title: viewer.role === "traveller" ? "You" : u.name, sub: u.guest ? "guest" : u.role, props: { role: u.role, guest: !!u.guest } });
    const tid = `trip:${t.id}`;
    const v = t.verifiedJson ? (JSON.parse(t.verifiedJson) as { by: string; at: string }) : null;
    if (v) verified++;
    nodes.set(tid, { id: tid, label: "Trip", title: t.destination, sub: `${t.dateStart} → ${t.dateEnd}${v ? " · verified" : ""}`, tripId: t.id, props: { verified: !!v, version: t.version ?? null } });
    edges.push({ from: uid, to: tid, type: "OWNS" });
    for (const d of (r.days as { key: string; dayIndex: number; date: string }[]) ?? []) {
      if (!d?.key) continue;
      const did = `day:${d.key}`;
      nodes.set(did, { id: did, label: "Day", title: `Day ${d.dayIndex}`, sub: d.date, tripId: t.id, dayIndex: d.dayIndex, props: { date: d.date } });
      edges.push({ from: tid, to: did, type: "HAS_DAY" });
    }
    for (const s of (r.stops as { id: string; title: string; category: string; isOutdoor: boolean; type: string; dayKey: string; start: string }[]) ?? []) {
      if (!s?.id) continue;
      const sid = `stop:${s.id}`;
      nodes.set(sid, {
        id: sid,
        label: "Stop",
        title: s.title,
        sub: `${s.start} · ${String(s.category).toLowerCase()}${s.type === "HARD" ? " · locked" : ""}`,
        tripId: t.id,
        dayIndex: Number(String(s.dayKey).split(":").pop()),
        props: { nodeId: s.id, category: s.category, outdoor: !!s.isOutdoor, locked: s.type === "HARD", start: s.start },
      });
      edges.push({ from: `day:${s.dayKey}`, to: sid, type: "HAS_STOP" });
    }
    for (const l of (r.legs as { from: string; to: string; mode: string; minutes: number }[]) ?? []) {
      if (!l?.from || !l.to) continue;
      edges.push({ from: `stop:${l.from}`, to: `stop:${l.to}`, type: "NEXT", label: `${l.minutes}m ${String(l.mode ?? "").toLowerCase()}` });
    }
    for (const raw of (r.proposals as { id: string; status: string; json: string }[]) ?? []) {
      const p = raw?.json ? parseProposal(raw.json) : null;
      if (!p || p.status !== "PENDING") continue;
      if (viewer.role === "traveller" && p.review && p.review.state !== "SENT") continue;
      if (p.review?.state === "OPERATOR") advisories++;
      else openCards++;
      const pid = `proposal:${p.id}`;
      nodes.set(pid, { id: pid, label: "Proposal", title: p.headline, sub: p.review?.state === "OPERATOR" ? "weather advisory · review" : "open card", tripId: t.id, dayIndex: p.dayIndex, props: { status: p.status } });
      edges.push({ from: pid, to: tid, type: "FOR" });
    }
  }
  const count = (l: GraphNode["label"]) => [...nodes.values()].filter((n) => n.label === l).length;
  return {
    nodes: [...nodes.values()],
    edges: edges.filter((e) => nodes.has(e.from) && nodes.has(e.to)),
    stats: { users: count("User"), trips: count("Trip"), days: count("Day"), stops: count("Stop"), openCards, verifiedTrips: verified, advisoriesForReview: advisories },
  };
}

/** Same shape from the file store (dev without Neo4j). */
async function fileRows(owner: string | null, limit: number): Promise<Row[]> {
  return read((db) =>
    db.trips
      .filter((t) => owner === null || t.ownerId === owner)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, limit)
      .map((t) => {
        const u = db.users.find((x) => x.id === t.ownerId);
        return {
          u: { id: t.ownerId, name: u?.name ?? "unknown", role: u?.role ?? "traveller", guest: !!u?.guest },
          t: { id: t.trip.id, destination: t.trip.destination, dateStart: t.trip.dateRange.start, dateEnd: t.trip.dateRange.end, verifiedJson: t.verified ? JSON.stringify(t.verified) : undefined, version: t.trip.version },
          days: t.trip.schedule.map((d) => ({ key: `${t.trip.id}:${d.dayIndex}`, dayIndex: d.dayIndex, date: d.date })),
          stops: t.trip.schedule.flatMap((d) => d.nodes.map((n) => ({ id: n.id, title: n.title, category: n.category, isOutdoor: n.isOutdoor, type: n.type, dayKey: `${t.trip.id}:${d.dayIndex}`, start: n.timeSlot.start }))),
          legs: t.trip.schedule.flatMap((d) => d.transitSegments.map((s) => ({ from: s.fromNodeId, to: s.toNodeId, mode: s.mode, minutes: s.durationMinutes }))),
          proposals: db.proposals.filter((p) => p.tripId === t.trip.id).map((p) => ({ id: p.id, status: p.status, json: JSON.stringify(p) })),
        };
      }),
  );
}

export async function graphFor(user: SessionUser): Promise<GraphView> {
  const owner = user.role === "operator" ? null : user.id;
  const limit = user.role === "operator" ? MAX_TRIPS.operator : MAX_TRIPS.traveller;
  // Same store the trips were written to (see activeStorageKind).
  if ((await activeStorageKind()) === "neo4j") {
    const m = await import("./store-neo4j.ts");
    return { source: "neo4j", cypher: m.GRAPH_CYPHER, ...build(await m.graphRows(owner, limit), user) };
  }
  return { source: "file", ...build(await fileRows(owner, limit), user) };
}

/** Operator marks a trip as checked end to end (or clears it). */
export async function setVerified(user: SessionUser, tripId: string, verified: boolean, note?: string) {
  if (user.role !== "operator") throw new HttpError(403, "Operators only");
  const version = await write((db) => {
    const rec = db.trips.find((t) => t.trip.id === tripId);
    if (!rec) throw new HttpError(404, "Trip not found");
    const at = new Date().toISOString();
    rec.verified = verified ? { by: `${user.name} (operator)`, at, ...(note?.trim() ? { note: note.trim() } : {}) } : undefined;
    rec.updatedAt = at;
    db.activity.push({ id: newId(), tripId, at, actor: `${user.name} (operator)`, message: verified ? "Verified this trip" : "Cleared verification" });
    return rec.trip.version;
  });
  publish({ type: "trip.updated", tripId, version });
  return { verified };
}
