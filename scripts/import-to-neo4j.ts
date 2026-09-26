/**
 * One-shot import of the local JSON store into Neo4j.
 *   npm run db:import-neo4j                 # imports .data/musafir.json
 *   npm run db:import-neo4j -- other.json   # another file
 *   npm run db:import-neo4j -- --force      # even if Neo4j already has data (upserts over it)
 * Reads NEO4J_URI / NEO4J_USERNAME / NEO4J_PASSWORD from .env.local.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { neo4jAdapter } from "../src/server/store-neo4j.ts";
import { EMPTY_DB, type Db } from "../src/server/store.ts";

const args = process.argv.slice(2);
const force = args.includes("--force");
const file = args.find((a) => !a.startsWith("--")) ?? path.join(process.env.MUSAFIR_DATA_DIR || ".data", "musafir.json");

const local: Db = { ...structuredClone(EMPTY_DB), ...(JSON.parse(await fs.readFile(file, "utf8")) as Partial<Db>) };
const adapter = await neo4jAdapter();
try {
  const { db: remote, rev } = await adapter.load();
  if (rev > 0 && !force) {
    console.error(`Neo4j already has data (rev ${rev}, ${remote.trips.length} trips). Re-run with --force to upsert the file over it.`);
    process.exitCode = 1;
  } else {
    const merged: Db = force
      ? {
          users: [...remote.users.filter((u) => !local.users.some((x) => x.id === u.id)), ...local.users],
          trips: [...remote.trips.filter((t) => !local.trips.some((x) => x.trip.id === t.trip.id)), ...local.trips],
          proposals: [...remote.proposals.filter((p) => !local.proposals.some((x) => x.id === p.id)), ...local.proposals],
          rooms: [...remote.rooms.filter((r) => !local.rooms.some((x) => x.id === r.id)), ...local.rooms],
          activity: [...remote.activity.filter((a) => !local.trips.some((t) => t.trip.id === a.tripId)), ...local.activity],
        }
      : local;
    const newRev = await adapter.persist(remote, merged, rev);
    const check = await adapter.load();
    const stops = check.db.trips.reduce((n, t) => n + t.trip.schedule.reduce((m, d) => m + d.nodes.length, 0), 0);
    console.log(`Imported from ${file}: ${check.db.users.length} users, ${check.db.trips.length} trips (${stops} stops), ${check.db.proposals.length} proposals, ${check.db.rooms.length} rooms. Rev ${newRev}.`);
  }
} finally {
  await adapter.close();
}
