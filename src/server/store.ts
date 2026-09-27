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
  /** Created automatically so the app works without login; upgraded in place by sign-up. */
  guest?: boolean;
}

export interface TripRecord {
  trip: TripState;
  ownerId: string;
  autonomy: AutonomyPolicy;
  /** Planner agent progress, shown live in the UI. */
  planner?: { status: "RUNNING" | "DONE" | "FAILED"; note: string; at: string };
  /** Last ambient sentinel run (rate limit). */
  lastSentinelAt?: string;
  /** An operator checked this trip end to end. */
  verified?: { by: string; at: string; note?: string };
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

/** What raised a proposal: an engine disruption, or an agent-led improvement. */
export type ProposalTrigger =
  | Disruption
  | { kind: "COMMUTE_SPIKE"; nodeId: string; reason: string }
  /** Traveller asked for a different place instead of one stop (optionally "a park", "something indoor"). */
  | { kind: "SWAP"; nodeId: string; reason: string; want?: string };

export type ProposalStatus = "PENDING" | "AUTO_APPLIED" | "APPLIED" | "DISMISSED" | "STALE" | "UNDONE";

export interface ProposalRecord {
  id: string;
  tripId: string;
  dayIndex: number;
  baseVersion: number;
  createdAt: string;
  createdBy: string;
  disruption: ProposalTrigger;
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
  /**
   * Weather advisories: the system (sentinel / forecast) raises them for the operator first.
   * Travellers only see them once an operator sends them, with the probability and a note.
   */
  review?: { state: "OPERATOR" | "SENT" | "DISMISSED"; probability?: number; note?: string; by?: string; at?: string };
}

export interface ActivityRecord {
  id: string;
  tripId: string;
  at: string;
  actor: string;
  message: string;
}

export interface RoomOption {
  id: string;
  name: string;
  nameNative?: string;
  lat: number;
  lng: number;
  kind: string;
  source: string;
  diet: "not-needed" | "verified" | "unverified";
  travelMinutes: number;
}

export interface RoomRecord {
  id: string;
  /** Unguessable join token (the share link). */
  token: string;
  tripId: string;
  dayIndex: number;
  ownerId: string;
  start: string;
  durationMinutes: number;
  options: RoomOption[];
  participants: { id: string; name: string; key: string; joinedAt: string }[];
  votes: Record<string, Record<string, "yes" | "no">>;
  status: "OPEN" | "DECIDED" | "CLOSED";
  winnerOptionId?: string;
  createdAt: string;
  expiresAt: string;
}

export interface Db {
  users: UserRecord[];
  trips: TripRecord[];
  proposals: ProposalRecord[];
  activity: ActivityRecord[];
  rooms: RoomRecord[];
}

export const EMPTY_DB: Db = { users: [], trips: [], proposals: [], activity: [], rooms: [] };
/** Activity entries kept per trip; older ones are trimmed on write. */
const MAX_ACTIVITY_PER_TRIP = 200;
/** How long a read trusts its cache before asking the database whether another instance wrote. */
const FRESHNESS_MS = 750;

/** Another instance wrote since we loaded; the write is retried on fresh data. */
export class RevConflictError extends Error {
  constructor() {
    super("The data changed on another server; retrying");
    this.name = "RevConflictError";
  }
}

/** By name too: after a dev hot-reload the cached adapter throws an older copy of the class. */
const isRevConflict = (e: unknown) => e instanceof RevConflictError || (e instanceof Error && e.name === "RevConflictError");
const WRITE_ATTEMPTS = 5;

/**
 * Where the data lives. The file store is the default (dev, tests, single
 * instance). Neo4j is used when NEO4J_URI/NEO4J_USERNAME/NEO4J_PASSWORD are set.
 * A misconfigured or paused database is an error — never a silent fallback to
 * the file (two sources of truth lose writes).
 */
export interface StorageAdapter {
  name: "file" | "neo4j";
  load(): Promise<{ db: Db; rev: number }>;
  /** Cheap check for writes from other instances; null = this adapter has no other writers. */
  currentRev(): Promise<number | null>;
  /** Persists `next` (diffing against `prev` if useful); throws RevConflictError if the rev moved. */
  persist(prev: Db, next: Db, expectedRev: number): Promise<number>;
}

const fileAdapter: StorageAdapter = {
  name: "file",
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Partial<Db>;
      return { db: { ...structuredClone(EMPTY_DB), ...raw }, rev: 0 };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return { db: structuredClone(EMPTY_DB), rev: 0 };
    }
  },
  async currentRev() {
    return null;
  },
  async persist(_prev, next) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
    await fs.rename(tmp, DB_FILE);
    return 0;
  },
};

export function storageKind(): "file" | "neo4j" {
  return process.env.NEO4J_URI ? "neo4j" : "file";
}

interface StoreState {
  db: Db | null;
  rev: number;
  checkedAt: number;
  adapter: Promise<StorageAdapter> | null;
  queue: Promise<unknown>;
}
const g = globalThis as typeof globalThis & { __musafirStore?: StoreState };
const state: StoreState = (g.__musafirStore ??= { db: null, rev: 0, checkedAt: 0, adapter: null, queue: Promise.resolve() });

let adapterPromise: Promise<StorageAdapter> | null = null;

function adapter(): Promise<StorageAdapter> {
  // Cached per module instance, not on globalThis: after a dev hot-reload the adapter must run the
  // new mapping code (a global cache kept saving trips with the old code). The Neo4j driver itself
  // stays shared on globalThis inside store-neo4j.ts, so no extra connections are opened.
  adapterPromise ??= storageKind() === "neo4j" ? import("./store-neo4j.ts").then((m) => m.neo4jAdapter()) : Promise.resolve(fileAdapter);
  return adapterPromise;
}

/**
 * The store actually in use. The adapter is chosen once per process, so this can
 * differ from storageKind() if the env changed after start (e.g. NEO4J_* added to
 * .env.local while the dev server ran). Readers that bypass read() must use this,
 * or they read one database while writes go to the other.
 */
export async function activeStorageKind(): Promise<"file" | "neo4j"> {
  return (await adapter()).name;
}

/** Beyond this, a read waits for the "did another server write?" check instead of revalidating in the background. */
const MAX_STALE_MS = 30_000;
let revalidating: Promise<void> | null = null;

async function revalidate(a: StorageAdapter): Promise<void> {
  const rev = await a.currentRev();
  state.checkedAt = Date.now();
  if (rev === null || rev === state.rev) return;
  const loaded = await a.load();
  state.db = loaded.db;
  state.rev = loaded.rev;
  state.checkedAt = Date.now();
}

/**
 * Loads once; afterwards reloads only if another instance has written since.
 * Stale-while-revalidate: a recent cache is served immediately while the rev
 * check runs in the background (a hosted database is a ~70 ms round trip).
 * Writes stay safe regardless — persist() rejects a stale rev and retries.
 */
async function fresh(force = false): Promise<Db> {
  const a = await adapter();
  if (state.db && !force) {
    const age = Date.now() - state.checkedAt;
    if (age < FRESHNESS_MS) return state.db;
    revalidating ??= revalidate(a)
      .catch(() => undefined)
      .finally(() => {
        revalidating = null;
      });
    if (age < MAX_STALE_MS) return state.db;
    await revalidating;
    return state.db!;
  }
  const loaded = await a.load();
  state.db = loaded.db;
  state.rev = loaded.rev;
  state.checkedAt = Date.now();
  return state.db;
}

/** Read-only snapshot. Do not mutate the result. */
export async function read<T>(fn: (db: Readonly<Db>) => T): Promise<T> {
  await state.queue.catch(() => undefined);
  return fn(await fresh());
}

/**
 * Serialized read-modify-write. `fn` mutates a draft; if it throws, nothing is
 * persisted and in-memory state is left untouched. `fn` may run again if
 * another instance wrote concurrently, so it must not have side effects
 * (publish events after `write` resolves, never inside).
 */
export function write<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
  const run = state.queue.catch(() => undefined).then(async () => {
    const a = await adapter();
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
      // Two servers on one database (e.g. dev + a test build): back off a little, with jitter.
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * attempt + Math.random() * 100));
      const current = await fresh(attempt > 0);
      const draft = structuredClone(current);
      const result = await fn(draft);
      const counts = new Map<string, number>();
      draft.activity = draft.activity
        .slice()
        .reverse()
        .filter((x) => {
          const n = (counts.get(x.tripId) ?? 0) + 1;
          counts.set(x.tripId, n);
          return n <= MAX_ACTIVITY_PER_TRIP;
        })
        .reverse();
      try {
        state.rev = await a.persist(current, draft, state.rev);
        state.db = draft;
        state.checkedAt = Date.now();
        return result;
      } catch (e) {
        if (!isRevConflict(e)) throw e;
      }
    }
    throw new Error("Too many concurrent changes; please try again");
  });
  state.queue = run;
  return run;
}
