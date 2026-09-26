/**
 * File-backed JSON store for local/demo use (`next dev` / `next start` on one
 * machine). Writes are serialized through one in-process queue and land
 * atomically (temp file + rename). State hangs off globalThis so dev hot reload
 * and separate server bundle layers share one instance.
 *
 * NOT suitable for serverless (Vercel): the filesystem is ephemeral and
 * instances don't share memory. Swap this module for a Supabase adapter there.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { DaySchedule, TripPatch, TripState } from "@/lib/musafir/schemas.ts";
import type { AutonomyPolicy, RiskAssessment, Role } from "@/lib/musafir/risk.ts";
import type { Conflict, Disruption } from "@/lib/musafir/reducer.ts";

export const DATA_DIR = process.env.MUSAFIR_DATA_DIR || path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "musafir.json");

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  salt: string;
  createdAt: string;
}

export interface TripRecord {
  trip: TripState;
  ownerId: string;
  autonomy: AutonomyPolicy;
  /** Planner agent progress, shown live in the UI. */
  planner?: { status: "RUNNING" | "DONE" | "FAILED"; note: string; at: string };
  createdAt: string;
  updatedAt: string;
}

export interface ProposalOption {
  id: string;
  label: string;
  source: "engine" | "agent";
  patches: TripPatch[];
  conflicts: Conflict[];
  risk: RiskAssessment;
  /** e.g. "llm:groq/openai/gpt-oss-20b" or "distance" — how an agent chose. */
  rankedBy?: string;
  rationale?: string;
}

export type ProposalStatus = "PENDING" | "AUTO_APPLIED" | "APPLIED" | "DISMISSED" | "STALE" | "UNDONE";

export interface ProposalRecord {
  id: string;
  tripId: string;
  dayIndex: number;
  baseVersion: number;
  createdAt: string;
  createdBy: string;
  disruption: Disruption;
  urgency: "INFO" | "RECOMMENDATION" | "CRITICAL";
  headline: string;
  context: string;
  options: ProposalOption[];
  status: ProposalStatus;
  operatorDeadline?: string;
  decidedBy?: string;
  decidedAt?: string;
  appliedOptionId?: string;
  appliedVersion?: number;
  undoSnapshot?: DaySchedule;
  agentStatus: "IDLE" | "RUNNING" | "DONE" | "FAILED";
  agentNote?: string;
  /** Nodes the disruption touched directly (agent targets). */
  affectedNodeIds: string[];
}

export interface ActivityRecord {
  id: string;
  tripId: string;
  at: string;
  actor: string;
  message: string;
}

export interface Db {
  users: UserRecord[];
  trips: TripRecord[];
  proposals: ProposalRecord[];
  activity: ActivityRecord[];
}

const EMPTY: Db = { users: [], trips: [], proposals: [], activity: [] };
/** Activity entries kept per trip; older ones are trimmed on write. */
const MAX_ACTIVITY_PER_TRIP = 200;

interface StoreState {
  db: Db | null;
  loading: Promise<Db> | null;
  queue: Promise<unknown>;
}
const g = globalThis as typeof globalThis & { __musafirStore?: StoreState };
const state: StoreState = (g.__musafirStore ??= { db: null, loading: null, queue: Promise.resolve() });

async function load(): Promise<Db> {
  if (state.db) return state.db;
  state.loading ??= (async () => {
    try {
      const raw = JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Partial<Db>;
      state.db = { ...structuredClone(EMPTY), ...raw };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      state.db = structuredClone(EMPTY);
    }
    return state.db;
  })();
  return state.loading;
}

async function persist(db: Db) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmp, DB_FILE);
}

/** Read-only snapshot. Do not mutate the result. */
export async function read<T>(fn: (db: Readonly<Db>) => T): Promise<T> {
  await state.queue.catch(() => undefined);
  return fn(await load());
}

/**
 * Serialized read-modify-write. `fn` mutates a draft; if it throws, nothing is
 * persisted and in-memory state is left untouched.
 */
export function write<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = state.queue.catch(() => undefined).then(async () => {
    const current = await load();
    const draft = structuredClone(current);
    const result = await fn(draft);
    const counts = new Map<string, number>();
    draft.activity = draft.activity
      .slice()
      .reverse()
      .filter((a) => {
        const n = (counts.get(a.tripId) ?? 0) + 1;
        counts.set(a.tripId, n);
        return n <= MAX_ACTIVITY_PER_TRIP;
      })
      .reverse();
    await persist(draft);
    state.db = draft;
    return result;
  });
  state.queue = run;
  return run;
}
