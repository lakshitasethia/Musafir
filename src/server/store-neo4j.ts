/**
 * Neo4j storage adapter (graph database). Selected when NEO4J_URI is set.
 *
 * Graph model:
 *   (:User)-[:OWNS]->(:Trip)-[:HAS_DAY]->(:Day)-[:HAS_STOP]->(:Stop)
 *   (:Stop)-[:NEXT {mode, durationMinutes, distanceMeters, fatigueScore}]->(:Stop)
 *   (:Proposal)-[:FOR]->(:Trip)      (:Room)-[:FOR]->(:Trip)      (:Meta {rev})
 * Nested/blob data (proposal options, room votes, stop metadata, activity) is
 * stored as JSON string properties — graph properties must be primitives.
 *
 * Concurrency: every write locks (:Meta), checks `rev`, writes only changed
 * entities, and bumps `rev` in one transaction. Readers compare `rev` to know
 * when another instance has written. Imports are relative (no "@/") so the
 * import script can run under plain Node.
 *
 * AuraDB Free (checked 2026-09-26): 50k nodes / 175k relationships, pauses
 * after 3 days idle — a paused database surfaces as a clear error, never as a
 * silent fallback to the file store.
 */
import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import { diffById, graphToTrip, tripToGraph } from "../lib/musafir/graph-mapping.ts";
import { EMPTY_DB, RevConflictError, type ActivityRecord, type Db, type StorageAdapter, type TripRecord } from "./store.ts";

const META_ID = "musafir";
/** Aura's credentials file names the database (NEO4J_DATABASE); otherwise the server default. */
const dbName = () => process.env.NEO4J_DATABASE || undefined;
type Row = Record<string, unknown>;

const g = globalThis as typeof globalThis & { __musafirNeo4j?: { driver: Driver; schema: Promise<void> | null } };

function driver(): Driver {
  const { NEO4J_URI: uri, NEO4J_USERNAME: user, NEO4J_PASSWORD: password } = process.env;
  if (!uri || !user || !password) throw new Error("NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD must all be set to use Neo4j");
  g.__musafirNeo4j ??= { driver: neo4j.driver(uri, neo4j.auth.basic(user, password), { disableLosslessIntegers: true }), schema: null };
  return g.__musafirNeo4j.driver;
}

function explain(e: unknown): Error {
  const err = e as { code?: string; message?: string };
  if (err.code === "ServiceUnavailable" || /ECONNREFUSED|ENOTFOUND|ServiceUnavailable/.test(err.message ?? "")) {
    return new Error("Neo4j is unreachable. If you use AuraDB Free, it pauses after 3 days without use — resume it in the Aura console, then retry.");
  }
  if (err.code === "Neo.ClientError.Security.Unauthorized") return new Error("Neo4j rejected the username/password in NEO4J_USERNAME / NEO4J_PASSWORD.");
  return e instanceof Error ? e : new Error(String(e));
}

async function ensureSchema(d: Driver) {
  g.__musafirNeo4j!.schema ??= (async () => {
    const session = d.session({ database: dbName() });
    try {
      for (const [label, key] of [["User", "id"], ["Trip", "id"], ["Day", "key"], ["Stop", "id"], ["Proposal", "id"], ["Room", "id"], ["Meta", "id"]]) {
        await session.run(`CREATE CONSTRAINT musafir_${label.toLowerCase()}_${key} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${key} IS UNIQUE`);
      }
      await session.run("CREATE INDEX musafir_room_token IF NOT EXISTS FOR (n:Room) ON (n.token)");
    } finally {
      await session.close();
    }
  })().catch((e) => {
    g.__musafirNeo4j!.schema = null;
    throw explain(e);
  });
  return g.__musafirNeo4j!.schema;
}

/** Drops undefined values so optional fields are absent (Neo4j has no "undefined"). */
const compact = (o: Row) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

function tripRecordRow(rec: TripRecord, activity: ActivityRecord[]): Row {
  const { trip } = tripToGraph(rec.trip);
  return compact({
    ...trip,
    ownerId: rec.ownerId,
    autonomyJson: JSON.stringify(rec.autonomy),
    plannerJson: rec.planner ? JSON.stringify(rec.planner) : undefined,
    lastSentinelAt: rec.lastSentinelAt,
    verifiedJson: rec.verified ? JSON.stringify(rec.verified) : undefined,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    activityJson: JSON.stringify(activity),
  });
}

async function readAll(tx: ManagedTransaction): Promise<{ db: Db; rev: number }> {
  const rows = async (q: string, key: string) => (await tx.run(q)).records.map((r) => r.get(key) as Row);
  const meta = await tx.run("MATCH (m:Meta {id: $id}) RETURN m.rev AS rev", { id: META_ID });
  const rev = Number(meta.records[0]?.get("rev") ?? 0);
  const users = await rows("MATCH (u:User) RETURN u {.*} AS x", "x");
  const trips = await rows("MATCH (t:Trip) RETURN t {.*} AS x", "x");
  const days = await rows("MATCH (d:Day) RETURN d {.*} AS x", "x");
  const stops = await rows("MATCH (s:Stop) RETURN s {.*} AS x", "x");
  const legs = await rows("MATCH (a:Stop)-[r:NEXT]->(b:Stop) RETURN r {.*, from: a.id, to: b.id} AS x", "x");
  const proposals = await rows("MATCH (p:Proposal) RETURN p.json AS x", "x");
  const rooms = await rows("MATCH (r:Room) RETURN r.json AS x", "x");

  const db: Db = structuredClone(EMPTY_DB);
  db.users = users as unknown as Db["users"];
  for (const t of trips) {
    const id = String(t.id);
    const tripDays = days.filter((d) => d.tripId === id);
    const keys = new Set(tripDays.map((d) => String(d.key)));
    const tripStops = stops.filter((s) => keys.has(String(s.dayKey)));
    const stopIds = new Set(tripStops.map((s) => String(s.id)));
    const trip = graphToTrip({ trip: t as never, days: tripDays as never, stops: tripStops as never, legs: legs.filter((l) => stopIds.has(String(l.from))) as never });
    db.trips.push(
      compact({
        trip,
        ownerId: String(t.ownerId),
        autonomy: JSON.parse(String(t.autonomyJson)),
        planner: t.plannerJson ? JSON.parse(String(t.plannerJson)) : undefined,
        lastSentinelAt: t.lastSentinelAt as string | undefined,
        verified: t.verifiedJson ? JSON.parse(String(t.verifiedJson)) : undefined,
        createdAt: String(t.createdAt),
        updatedAt: String(t.updatedAt),
      }) as unknown as TripRecord,
    );
    db.activity.push(...(JSON.parse(String(t.activityJson ?? "[]")) as ActivityRecord[]));
  }
  db.activity.sort((a, b) => a.at.localeCompare(b.at));
  db.proposals = (proposals as unknown as string[]).map((j) => JSON.parse(j));
  db.proposals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  db.rooms = (rooms as unknown as string[]).map((j) => JSON.parse(j));
  db.rooms.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { db, rev };
}

/** Replaces a trip's Day/Stop subgraph and ownership in one round trip (unit subqueries run in order). */
const TRIP_UPSERT = `MERGE (t:Trip {id: $id}) SET t = $row
WITH t
CALL { WITH t MATCH (t)-[:HAS_DAY]->(d:Day) OPTIONAL MATCH (d)-[:HAS_STOP]->(s:Stop) DETACH DELETE s, d }
CALL { WITH t UNWIND $days AS row CREATE (d:Day) SET d = row CREATE (t)-[:HAS_DAY]->(d) }
CALL { UNWIND $stops AS row MATCH (d:Day {key: row.dayKey}) CREATE (s:Stop) SET s = row CREATE (d)-[:HAS_STOP]->(s) }
CALL { UNWIND $legs AS row MATCH (a:Stop {id: row.from}), (b:Stop {id: row.to}) CREATE (a)-[r:NEXT]->(b) SET r.mode = row.mode, r.durationMinutes = row.durationMinutes, r.distanceMeters = row.distanceMeters, r.fatigueScore = row.fatigueScore }
CALL { WITH t OPTIONAL MATCH (:User)-[o:OWNS]->(t) DELETE o }
WITH t MATCH (u:User {id: $owner}) MERGE (u)-[:OWNS]->(t)`;

async function writeDiff(tx: ManagedTransaction, prev: Db, next: Db) {
  // Users
  const users = diffById(prev.users, next.users, (u) => u.id);
  if (users.upserts.length) await tx.run("UNWIND $rows AS row MERGE (u:User {id: row.id}) SET u = row", { rows: users.upserts.map((u) => compact({ ...u })) });
  if (users.deletes.length) await tx.run("MATCH (u:User) WHERE u.id IN $ids DETACH DELETE u", { ids: users.deletes });

  // Trips (record + its activity) → Trip/Day/Stop subgraph
  const activityOf = (db: Db, id: string) => db.activity.filter((a) => a.tripId === id);
  const withActivity = (db: Db) => db.trips.map((rec) => ({ rec, activity: activityOf(db, rec.trip.id) }));
  const trips = diffById(withActivity(prev), withActivity(next), (x) => x.rec.trip.id);
  for (const { rec } of trips.upserts) {
    const id = rec.trip.id;
    const graph = tripToGraph(rec.trip);
    // One statement per trip (was six): each round trip to a hosted database costs ~70 ms.
    await tx.run(TRIP_UPSERT, { id, row: tripRecordRow(rec, activityOf(next, id)), days: graph.days, stops: graph.stops, legs: graph.legs, owner: rec.ownerId });
  }
  if (trips.deletes.length) {
    await tx.run("MATCH (t:Trip) WHERE t.id IN $ids OPTIONAL MATCH (t)-[:HAS_DAY]->(d:Day) OPTIONAL MATCH (d)-[:HAS_STOP]->(s:Stop) DETACH DELETE s, d, t", { ids: trips.deletes });
  }

  // Proposals and rooms: JSON documents linked to their trip.
  const proposals = diffById(prev.proposals, next.proposals, (p) => p.id);
  if (proposals.upserts.length) {
    await tx.run(
      "UNWIND $rows AS row MERGE (p:Proposal {id: row.id}) SET p.tripId = row.tripId, p.status = row.status, p.createdAt = row.createdAt, p.json = row.json WITH p, row MATCH (t:Trip {id: row.tripId}) MERGE (p)-[:FOR]->(t)",
      { rows: proposals.upserts.map((p) => ({ id: p.id, tripId: p.tripId, status: p.status, createdAt: p.createdAt, json: JSON.stringify(p) })) },
    );
  }
  if (proposals.deletes.length) await tx.run("MATCH (p:Proposal) WHERE p.id IN $ids DETACH DELETE p", { ids: proposals.deletes });
  const rooms = diffById(prev.rooms, next.rooms, (r) => r.id);
  if (rooms.upserts.length) {
    await tx.run(
      "UNWIND $rows AS row MERGE (r:Room {id: row.id}) SET r.token = row.token, r.tripId = row.tripId, r.status = row.status, r.json = row.json WITH r, row MATCH (t:Trip {id: row.tripId}) MERGE (r)-[:FOR]->(t)",
      { rows: rooms.upserts.map((r) => ({ id: r.id, token: r.token, tripId: r.tripId, status: r.status, json: JSON.stringify(r) })) },
    );
  }
  if (rooms.deletes.length) await tx.run("MATCH (r:Room) WHERE r.id IN $ids DETACH DELETE r", { ids: rooms.deletes });
}

export async function neo4jAdapter(): Promise<StorageAdapter & { close(): Promise<void> }> {
  const d = driver();
  await ensureSchema(d);
  return {
    name: "neo4j",
    async load() {
      const session = d.session({ database: dbName(), defaultAccessMode: neo4j.session.READ });
      try {
        return await session.executeRead(readAll);
      } catch (e) {
        throw explain(e);
      } finally {
        await session.close();
      }
    },
    async currentRev() {
      const session = d.session({ database: dbName(), defaultAccessMode: neo4j.session.READ });
      try {
        const r = await session.executeRead((tx) => tx.run("MATCH (m:Meta {id: $id}) RETURN m.rev AS rev", { id: META_ID }));
        return Number(r.records[0]?.get("rev") ?? 0);
      } catch (e) {
        throw explain(e);
      } finally {
        await session.close();
      }
    },
    async persist(prev, next, expectedRev) {
      const session = d.session({ database: dbName(), defaultAccessMode: neo4j.session.WRITE });
      try {
        return await session.executeWrite(async (tx) => {
          // SET takes the write lock on Meta first, so concurrent writers queue here.
          const m = await tx.run("MERGE (m:Meta {id: $id}) ON CREATE SET m.rev = 0 SET m.touchedAt = timestamp() RETURN m.rev AS rev", { id: META_ID });
          if (Number(m.records[0].get("rev")) !== expectedRev) throw new RevConflictError();
          await writeDiff(tx, prev, next);
          const r = await tx.run("MATCH (m:Meta {id: $id}) SET m.rev = m.rev + 1 RETURN m.rev AS rev", { id: META_ID });
          return Number(r.records[0].get("rev"));
        });
      } catch (e) {
        if (e instanceof RevConflictError || (e instanceof Error && e.name === "RevConflictError")) throw e;
        throw explain(e);
      } finally {
        await session.close();
      }
    },
    async close() {
      await d.close();
      delete g.__musafirNeo4j;
    },
  };
}

/** The dashboards' graph query, shown to users as-is so they can see what Neo4j is asked. */
export const GRAPH_CYPHER = `MATCH (u:User)-[:OWNS]->(t:Trip)
WHERE $owner IS NULL OR u.id = $owner
WITH u, t ORDER BY t.updatedAt DESC LIMIT $limit
CALL { WITH t MATCH (t)-[:HAS_DAY]->(d:Day) RETURN collect(d {.key, .dayIndex, .date}) AS days }
CALL { WITH t MATCH (t)-[:HAS_DAY]->(:Day)-[:HAS_STOP]->(s:Stop)
       RETURN collect(s {.id, .title, .category, .isOutdoor, .type, .dayKey, .start}) AS stops }
CALL { WITH t MATCH (t)-[:HAS_DAY]->(:Day)-[:HAS_STOP]->(s:Stop)-[nx:NEXT]->(s2:Stop)
       RETURN collect({from: s.id, to: s2.id, mode: nx.mode, minutes: nx.durationMinutes}) AS legs }
CALL { WITH t MATCH (p:Proposal)-[:FOR]->(t) WHERE p.status = 'PENDING' RETURN collect(p {.id, .status, .json}) AS proposals }
RETURN u {.id, .name, .role, .guest} AS u,
       t {.id, .destination, .dateStart, .dateEnd, .verifiedJson, .version} AS t,
       days, stops, legs, proposals`;

/** Read-only: runs GRAPH_CYPHER. The user projection is explicit, so password fields are never read. */
export async function graphRows(owner: string | null, limit: number): Promise<Row[]> {
  const d = driver();
  const session = d.session({ database: dbName(), defaultAccessMode: neo4j.session.READ });
  try {
    const res = await session.run(GRAPH_CYPHER, { owner, limit: neo4j.int(limit) });
    return res.records.map((r) => r.toObject() as Row);
  } catch (e) {
    throw explain(e);
  } finally {
    await session.close();
  }
}
