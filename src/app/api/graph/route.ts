import { requireUser } from "@/server/auth.ts";
import { graphFor } from "@/server/graph.ts";
import { handle } from "@/server/http.ts";

/** GET /api/graph — the live trip graph from Neo4j: your trips (traveller) or the fleet (operator). */
export const GET = handle(async () => graphFor(await requireUser()));
