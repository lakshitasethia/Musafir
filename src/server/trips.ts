/**
 * Trip domain service — the only place trip state changes. Every mutation:
 *   1. authorizes the caller (role + ownership),
 *   2. checks the client's base version (optimistic concurrency),
 *   3. re-validates patches with applyPatches and re-classifies risk server-side,
 *   4. persists, logs activity, and publishes a realtime event.
 */
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import { heal, applyPatches, policyFromVibe, ScheduleError, type Disruption } from "@/lib/musafir/reducer.ts";
import { classifyRisk, canDecide, AutonomyPolicySchema, DEFAULT_AUTONOMY, type RiskTier } from "@/lib/musafir/risk.ts";
import { TripPatchSchema, VibeConfigSchema, type DaySchedule, type TripState } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY } from "@/lib/musafir/time.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { publish } from "./events.ts";
import { PLANNER_STALE_MS } from "./planner.ts";
import { routedLookup, warmLegs } from "./routing.ts";
import { auditTrip } from "./auditors.ts";
import { read, write, type Db, type ProposalOption, type ProposalRecord, type TripRecord } from "./store.ts";

const MAX_TRIP_DAYS = 30;
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CreateTripSchema = z
  .object({
    destination: z.string().trim().min(1).max(120),
    startDate: DATE,
    endDate: DATE,
    vibeConfig: VibeConfigSchema.optional(),
    dietaryRestrictions: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    autoPlan: z.boolean().default(true),
  })
  .refine((v) => v.endDate >= v.startDate, { message: "End date must be on or after the start date" });

export const TripSettingsSchema = z.object({
  vibeConfig: VibeConfigSchema.optional(),
  dietaryRestrictions: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  autonomy: AutonomyPolicySchema.partial().optional(),
});

export const DisruptionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DELAY"), nodeId: z.uuid(), delayMinutes: z.number().int().min(1).max(MINUTES_PER_DAY), reason: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal("CLOSURE"), nodeId: z.uuid(), reason: z.string().trim().min(1).max(160) }),
  z.object({
    kind: z.literal("WEATHER"),
    fromMinute: z.number().int().min(0).max(MINUTES_PER_DAY - 1),
    toMinute: z.number().int().min(1).max(MINUTES_PER_DAY),
    reason: z.string().trim().min(1).max(160),
  }),
]);

export const DirectPatchSchema = z.object({
  baseVersion: z.number().int(),
  patches: z.array(TripPatchSchema).min(1).max(50),
});

// ── helpers ──────────────────────────────────────────────────────────
function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (d <= last) {
    out.push(d.toISOString().slice(0, 10));
    if (out.length > MAX_TRIP_DAYS) throw new HttpError(400, `Trips can be at most ${MAX_TRIP_DAYS} days`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function canView(user: SessionUser, rec: TripRecord) {
  return user.role === "operator" || rec.ownerId === user.id;
}

/** Weather advisories reach the traveller only after an operator sends them. */
function visibleTo(user: SessionUser, p: ProposalRecord) {
  return user.role === "operator" || !p.review || p.review.state === "SENT";
}

function findTrip(db: Db, user: SessionUser, tripId: string): TripRecord {
  const rec = db.trips.find((t) => t.trip.id === tripId);
  if (!rec || !canView(user, rec)) throw new HttpError(404, "Trip not found");
  return rec;
}

function findDay(rec: TripRecord, dayIndex: number): DaySchedule {
  const day = rec.trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day) throw new HttpError(404, `Day ${dayIndex} not found`);
  return day;
}

function setDay(rec: TripRecord, day: DaySchedule) {
  rec.trip.schedule = rec.trip.schedule.map((d) => (d.dayIndex === day.dayIndex ? day : d));
  rec.trip.version += 1;
  rec.updatedAt = new Date().toISOString();
}

function log(db: Db, tripId: string, actor: string, message: string) {
  db.activity.push({ id: newId(), tripId, at: new Date().toISOString(), actor, message });
}

/** Background actor for ambient checks: can see every trip, still bound by risk tiers. */
export const SENTINEL_ACTOR: SessionUser = { id: "system:sentinel", email: "", name: "Sentinel", role: "operator", guest: false };
const actorOf = (u: SessionUser) => (u.id.startsWith("system:") ? u.name.toLowerCase() : `${u.name} (${u.role})`);

export function isEscalated(p: ProposalRecord, now = Date.now()) {
  return p.status === "PENDING" && !!p.operatorDeadline && Date.parse(p.operatorDeadline) < now;
}

function toHttp(e: unknown): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof ScheduleError) throw new HttpError(422, e.message);
  if (e instanceof z.ZodError) throw new HttpError(422, e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  throw e;
}

/**
 * Best-effort: fetch routed travel times for a day's stops (plus any new ones)
 * before a write, so the synchronous engine can use them. Never throws.
 */
async function warmDay(tripId: string, dayIndex: number, extra: { lat: number; lng: number }[] = []) {
  const points = await read((db) => db.trips.find((t) => t.trip.id === tripId)?.trip.schedule.find((d) => d.dayIndex === dayIndex)?.nodes.map((n) => n.location) ?? []);
  await warmLegs([...points, ...extra]).catch(() => undefined);
}

// ── queries ──────────────────────────────────────────────────────────
export async function listTrips(user: SessionUser) {
  return read((db) =>
    db.trips
      .filter((t) => canView(user, t))
      .map((t) => ({
        id: t.trip.id,
        destination: t.trip.destination,
        dateRange: t.trip.dateRange,
        stops: t.trip.schedule.reduce((n, d) => n + d.nodes.length, 0),
        owner: db.users.find((u) => u.id === t.ownerId)?.name ?? "unknown",
        pending: db.proposals.filter((p) => p.tripId === t.trip.id && p.status === "PENDING" && visibleTo(user, p)).length,
        updatedAt: t.updatedAt,
      }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  );
}

/** Travellers see "your operator", never an operator's personal name. */
const OPERATOR_ACTOR = / \(operator\)$/;
const maskFor = (viewer: SessionUser) => (actor: string | undefined) => (viewer.role === "traveller" && actor && OPERATOR_ACTOR.test(actor) ? "your operator" : actor);

export async function getTripBundle(user: SessionUser, tripId: string) {
  return read((db) => {
    const rec = findTrip(db, user, tripId);
    const now = Date.now();
    const mask = maskFor(user);
    return {
      trip: rec.trip,
      // The escalation policy is operator configuration; travellers get decisions (canDecide), not the rules.
      autonomy: user.role === "operator" ? rec.autonomy : null,
      planner: rec.planner ?? null,
      findings: auditTrip(rec.trip),
      owner: db.users.find((u) => u.id === rec.ownerId)?.name ?? "unknown",
      proposals: db.proposals
        .filter((p) => p.tripId === tripId && visibleTo(user, p))
        .slice(-40)
        .reverse()
        .map(({ undoSnapshot, ...p }) => ({
          ...p,
          createdBy: mask(p.createdBy)!,
          decidedBy: mask(p.decidedBy),
          undoable: !!undoSnapshot && (p.status === "APPLIED" || p.status === "AUTO_APPLIED") && p.appliedVersion === rec.trip.version,
          escalated: isEscalated(p, now),
          canDecide: p.options.map((o) =>
            canDecide(user.role, o.risk, { escalated: isEscalated(p, now), policy: rec.autonomy }),
          ),
        })),
      activity: db.activity.filter((a) => a.tripId === tripId).slice(-60).reverse().map((a) => ({ ...a, actor: mask(a.actor)! })),
    };
  });
}
export type TripBundle = Awaited<ReturnType<typeof getTripBundle>>;

export async function operatorQueue(user: SessionUser) {
  if (user.role !== "operator") throw new HttpError(403, "Operators only");
  return read((db) => {
    const now = Date.now();
    return db.proposals
      .filter((p) => p.status === "PENDING" && (p.review?.state === "OPERATOR" || p.options.some((o) => o.risk.tier === "OPERATOR")))
      .map((full) => {
        const { undoSnapshot, ...p } = full;
        void undoSnapshot;
        const rec = db.trips.find((t) => t.trip.id === p.tripId);
        return { ...p, destination: rec?.trip.destination ?? "?", escalated: isEscalated(p, now) };
      })
      .sort((a, b) => (a.operatorDeadline ?? a.createdAt).localeCompare(b.operatorDeadline ?? b.createdAt));
  });
}

// ── mutations ────────────────────────────────────────────────────────
export async function createTrip(user: SessionUser, input: z.infer<typeof CreateTripSchema>) {
  if (user.role !== "traveller") throw new HttpError(403, "Trips are created by travellers");
  const dates = datesBetween(input.startDate, input.endDate);
  const now = new Date().toISOString();
  const trip: TripState = {
    id: newId(),
    userId: user.id,
    destination: input.destination,
    dateRange: { start: input.startDate, end: input.endDate },
    vibeConfig: input.vibeConfig ?? { pacing: 0.5, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 },
    dietaryRestrictions: input.dietaryRestrictions ?? [],
    schedule: dates.map((date, i) => ({ dayIndex: i + 1, date, nodes: [], transitSegments: [], dailyFatigueScore: 0 })),
    version: 1,
  };
  return write((db) => {
    db.trips.push({
      trip,
      ownerId: user.id,
      autonomy: DEFAULT_AUTONOMY,
      planner: input.autoPlan ? { status: "RUNNING", note: "Planner starting…", at: now } : undefined,
      createdAt: now,
      updatedAt: now,
    });
    log(db, trip.id, actorOf(user), `Created trip to ${trip.destination}`);
    return trip.id;
  });
}

/** Marks the planner as starting; the caller runs runPlanner() after the response. */
export async function startPlanner(user: SessionUser, tripId: string) {
  await write((db) => {
    const rec = findTrip(db, user, tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    const p = rec.planner;
    if (p?.status === "RUNNING" && Date.now() - Date.parse(p.at) < PLANNER_STALE_MS) throw new HttpError(409, "The planner is already working on this trip");
    if (rec.trip.schedule.every((d) => d.nodes.length > 0)) throw new HttpError(409, "Every day already has stops — clear a day to re-plan it");
    rec.planner = { status: "RUNNING", note: "Planner starting…", at: new Date().toISOString() };
    log(db, tripId, actorOf(user), "Asked the planner agent to draft empty days");
  });
  publish({ type: "activity", tripId, message: "planner started" });
}

export async function updateTripSettings(user: SessionUser, tripId: string, input: z.infer<typeof TripSettingsSchema>) {
  const version = await write((db) => {
    const rec = findTrip(db, user, tripId);
    if (input.autonomy) {
      if (user.role !== "operator") throw new HttpError(403, "Only operators change autonomy rules");
      rec.autonomy = AutonomyPolicySchema.parse({ ...rec.autonomy, ...input.autonomy });
      log(db, tripId, actorOf(user), "Updated autonomy rules");
    }
    if (input.vibeConfig || input.dietaryRestrictions) {
      if (user.role !== "traveller" || rec.ownerId !== user.id) throw new HttpError(403, "Only the traveller edits their preferences");
      if (input.vibeConfig) rec.trip.vibeConfig = input.vibeConfig;
      if (input.dietaryRestrictions) rec.trip.dietaryRestrictions = input.dietaryRestrictions;
      log(db, tripId, actorOf(user), "Updated preferences");
    }
    rec.trip.version += 1;
    rec.updatedAt = new Date().toISOString();
    return rec.trip.version;
  });
  publish({ type: "trip.updated", tripId, version });
}

/** Tier 1: direct edits from the graph UI. Travellers can't touch locked (HARD) bookings. */
export async function applyDirectPatches(user: SessionUser, tripId: string, dayIndex: number, input: z.infer<typeof DirectPatchSchema>) {
  await warmDay(tripId, dayIndex, input.patches.flatMap((p) => (p.payload ? [p.payload.location] : [])));
  const version = await write((db) => {
    const rec = findTrip(db, user, tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    if (rec.trip.version !== input.baseVersion) throw new HttpError(409, "The trip changed since you loaded it — refreshed");
    const day = findDay(rec, dayIndex);
    if (user.role === "traveller") {
      const hardIds = new Set(day.nodes.filter((n) => n.type === "HARD").map((n) => n.id));
      for (const p of input.patches) {
        if ((p.nodeId && hardIds.has(p.nodeId)) || p.payload?.type === "HARD") {
          throw new HttpError(403, "Locked bookings are managed by your operator");
        }
      }
    }
    try {
      setDay(rec, applyPatches(day, input.patches, { routed: routedLookup }));
    } catch (e) {
      toHttp(e);
    }
    const summary = input.patches.map((p) => p.reason).filter(Boolean).slice(0, 3).join("; ");
    log(db, tripId, actorOf(user), `Edited day ${dayIndex}: ${summary || `${input.patches.length} change(s)`}`);
    return rec.trip.version;
  });
  publish({ type: "trip.updated", tripId, version });
  return version;
}

function describe(d: Disruption, day: DaySchedule) {
  const title = (id: string) => day.nodes.find((n) => n.id === id)?.title ?? "a stop";
  const hhmm = (m: number) => (m >= MINUTES_PER_DAY ? "midnight" : fromMinutes(m));
  switch (d.kind) {
    case "DELAY":
      return { headline: `Running ${d.delayMinutes} min behind for ${title(d.nodeId)}`, what: d.reason };
    case "CLOSURE":
      return { headline: `${title(d.nodeId)} is closed today`, what: d.reason };
    case "WEATHER":
      return { headline: `Rain expected ${hhmm(d.fromMinute)}–${hhmm(d.toMinute)}`, what: d.reason };
  }
}

function urgencyFor(tier: RiskTier): ProposalRecord["urgency"] {
  return tier === "OPERATOR" ? "CRITICAL" : tier === "TRAVELLER" ? "RECOMMENDATION" : "INFO";
}

export function buildEngineOption(rec: TripRecord, day: DaySchedule, disruption: Disruption): { option: ProposalOption; affected: string[] } {
  const result = heal(day, disruption, { policy: policyFromVibe(rec.trip.vibeConfig), routed: routedLookup });
  const risk = classifyRisk(day, result.patches, result.conflicts, rec.autonomy);
  const n = result.patches.length;
  const label =
    n === 0
      ? result.conflicts.length
        ? "Flag for review — nothing can move automatically"
        : "No change needed"
      : `Adjust ${n} stop${n === 1 ? "" : "s"}${result.patches.some((p) => p.operation === "REMOVE") ? " (includes a skip)" : ""}`;
  return {
    option: { id: newId(), label, source: "engine", patches: result.patches, conflicts: result.conflicts, risk },
    affected: result.affectedNodeIds,
  };
}

/** Creates a proposal from a disruption; auto-applies when the server classifies it AUTO. */
export async function createDisruptionProposal(
  user: SessionUser,
  tripId: string,
  dayIndex: number,
  disruption: Disruption,
  opts: { review?: { probability?: number } } = {},
) {
  await warmDay(tripId, dayIndex);
  const out = await write((db) => {
    const rec = findTrip(db, user, tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    const day = findDay(rec, dayIndex);
    let built: ReturnType<typeof buildEngineOption>;
    try {
      built = buildEngineOption(rec, day, disruption);
    } catch (e) {
      toHttp(e);
    }
    const { option, affected } = built;
    const { headline, what } = describe(disruption, day);
    const now = new Date();
    const proposal: ProposalRecord = {
      id: newId(),
      tripId,
      dayIndex,
      baseVersion: rec.trip.version,
      createdAt: now.toISOString(),
      createdBy: actorOf(user),
      disruption,
      urgency: urgencyFor(option.risk.tier),
      headline,
      context: `${what}. ${option.risk.reasons.length ? `Needs: ${option.risk.reasons.slice(0, 3).join("; ")}.` : "Fits within your trip's automatic limits."}`,
      options: [option],
      status: "PENDING",
      agentStatus: "IDLE",
      affectedNodeIds: affected,
    };
    if (option.risk.tier === "OPERATOR") {
      proposal.operatorDeadline = new Date(now.getTime() + rec.autonomy.operatorTimeoutMinutes * 60_000).toISOString();
    }
    if (opts.review) {
      // Held for the operator: never auto-applied, invisible to the traveller until sent.
      proposal.review = { state: "OPERATOR", ...(opts.review.probability !== undefined ? { probability: opts.review.probability } : {}) };
      proposal.urgency = "RECOMMENDATION";
      log(db, tripId, actorOf(user), `Weather advisory for operator review: ${headline}`);
    } else if (option.risk.tier === "AUTO" && option.patches.length > 0) {
      proposal.undoSnapshot = day;
      setDay(rec, applyPatches(day, option.patches, { routed: routedLookup }));
      proposal.status = "AUTO_APPLIED";
      proposal.appliedOptionId = option.id;
      proposal.appliedVersion = rec.trip.version;
      proposal.decidedBy = "engine (auto)";
      proposal.decidedAt = now.toISOString();
      log(db, tripId, "engine", `Auto-applied: ${headline} — ${option.label}`);
    } else {
      log(db, tripId, actorOf(user), `Reported: ${headline} → ${option.risk.tier === "OPERATOR" ? "sent to operator" : "awaiting traveller"}`);
    }
    db.proposals.push(proposal);
    return { proposal, version: rec.trip.version };
  });
  publish({ type: "proposal.changed", tripId, proposalId: out.proposal.id });
  publish({ type: "trip.updated", tripId, version: out.version });
  return out.proposal;
}

export async function decideProposal(user: SessionUser, proposalId: string, decision: "APPLY" | "DISMISS", optionId?: string) {
  const out = await write((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    if (!p) throw new HttpError(404, "Proposal not found");
    const rec = findTrip(db, user, p.tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    if (p.status !== "PENDING") throw new HttpError(409, `Already ${p.status.toLowerCase().replace("_", " ")}`);
    const escalated = isEscalated(p);
    const now = new Date().toISOString();

    if (decision === "DISMISS") {
      const needsOperator = p.options.every((o) => o.risk.tier === "OPERATOR");
      if (needsOperator && !p.options.some((o) => canDecide(user.role, o.risk, { escalated, policy: rec.autonomy }))) {
        throw new HttpError(403, "Waiting on your operator");
      }
      Object.assign(p, { status: "DISMISSED", decidedBy: actorOf(user), decidedAt: now });
      log(db, p.tripId, actorOf(user), `Dismissed: ${p.headline}`);
      return { tripId: p.tripId, version: rec.trip.version };
    }

    const option = p.options.find((o) => o.id === optionId);
    if (!option) throw new HttpError(400, "Pick an option to apply");
    if (option.patches.length === 0) {
      // Notice-only card (e.g. late for a locked booking): acknowledge without touching the plan or its version.
      if (!canDecide(user.role, option.risk, { escalated, policy: rec.autonomy })) throw new HttpError(403, "Waiting on your operator");
      Object.assign(p, { status: "APPLIED", appliedOptionId: option.id, decidedBy: actorOf(user), decidedAt: now });
      log(db, p.tripId, actorOf(user), `Acknowledged: ${p.headline}`);
      return { tripId: p.tripId, version: rec.trip.version };
    }
    if (rec.trip.version !== p.baseVersion) {
      Object.assign(p, { status: "STALE", decidedAt: now });
      log(db, p.tripId, "engine", `Marked stale (trip changed since it was computed): ${p.headline}`);
      return { tripId: p.tripId, version: rec.trip.version, stale: true };
    }
    const day = findDay(rec, p.dayIndex);
    let risk;
    try {
      risk = classifyRisk(day, option.patches, option.conflicts, rec.autonomy); // re-check; never trust stored tier alone
    } catch (e) {
      toHttp(e);
    }
    if (!canDecide(user.role, risk, { escalated, policy: rec.autonomy })) throw new HttpError(403, "This change needs your operator's approval");
    try {
      setDay(rec, applyPatches(day, option.patches, { routed: routedLookup }));
    } catch (e) {
      toHttp(e);
    }
    Object.assign(p, {
      status: "APPLIED",
      appliedOptionId: option.id,
      appliedVersion: rec.trip.version,
      undoSnapshot: day,
      decidedBy: actorOf(user),
      decidedAt: now,
    });
    log(db, p.tripId, actorOf(user), `Applied: ${p.headline} — ${option.label}`);
    return { tripId: p.tripId, version: rec.trip.version };
  });
  publish({ type: "proposal.changed", tripId: out.tripId, proposalId });
  publish({ type: "trip.updated", tripId: out.tripId, version: out.version });
  return out;
}

export async function undoProposal(user: SessionUser, proposalId: string) {
  const out = await write((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    if (!p) throw new HttpError(404, "Proposal not found");
    const rec = findTrip(db, user, p.tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    if ((p.status !== "APPLIED" && p.status !== "AUTO_APPLIED") || !p.undoSnapshot) throw new HttpError(409, "Nothing to undo");
    if (p.appliedVersion !== rec.trip.version) throw new HttpError(409, "Later changes were made on top of this; undo those first");
    const applied = p.options.find((o) => o.id === p.appliedOptionId);
    if (user.role === "traveller" && applied?.risk.tier === "OPERATOR") throw new HttpError(403, "Only your operator can undo this");
    setDay(rec, p.undoSnapshot);
    Object.assign(p, { status: "UNDONE", undoSnapshot: undefined });
    log(db, p.tripId, actorOf(user), `Undid: ${p.headline}`);
    return { tripId: p.tripId, version: rec.trip.version };
  });
  publish({ type: "proposal.changed", tripId: out.tripId, proposalId });
  publish({ type: "trip.updated", tripId: out.tripId, version: out.version });
}

/** Opens a "Cluster Nearby" card for a commute-spike leg; the agent fills it after the response. */
export async function startClusterProposal(user: SessionUser, tripId: string, dayIndex: number, nodeId: string) {
  const out = await write((db) => {
    const rec = findTrip(db, user, tripId);
    if (user.role === "traveller" && rec.ownerId !== user.id) throw new HttpError(403, "Not your trip");
    const day = findDay(rec, dayIndex);
    const idx = day.nodes.findIndex((n) => n.id === nodeId);
    if (idx === -1) throw new HttpError(404, "Stop not found");
    if (idx === 0) throw new HttpError(422, "The first stop has no previous stop to cluster around");
    const target = day.nodes[idx];
    if (target.type === "HARD") throw new HttpError(422, "Locked bookings can't be swapped");
    const dup = db.proposals.some((p) => p.tripId === tripId && p.status === "PENDING" && p.disruption.kind === "COMMUTE_SPIKE" && p.disruption.nodeId === nodeId);
    if (dup) throw new HttpError(409, "Already looking for a closer option for this stop");
    const proposal: ProposalRecord = {
      id: newId(),
      tripId,
      dayIndex,
      baseVersion: rec.trip.version,
      createdAt: new Date().toISOString(),
      createdBy: actorOf(user),
      disruption: { kind: "COMMUTE_SPIKE", nodeId, reason: "Long commute" },
      urgency: "RECOMMENDATION",
      headline: `Long ride to ${target.title}`,
      context: `Looking for a similar place near "${day.nodes[idx - 1].title}" that cuts travel time.`,
      options: [],
      status: "PENDING",
      agentStatus: "RUNNING",
      agentNote: "Starting…",
      affectedNodeIds: [nodeId],
    };
    db.proposals.push(proposal);
    log(db, tripId, actorOf(user), `Asked to cluster nearby: ${target.title}`);
    return proposal.id;
  });
  publish({ type: "proposal.changed", tripId, proposalId: out });
  return out;
}

/**
 * Operator reviews a weather advisory: send it to the traveller (with the chance
 * of rain and an optional note) or dismiss it. Nothing about the trip changes
 * here — the traveller still taps to accept the prepared plan.
 */
export async function reviewAdvisory(user: SessionUser, proposalId: string, action: "SEND" | "DISMISS", note?: string) {
  if (user.role !== "operator") throw new HttpError(403, "Operators only");
  const out = await write((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    if (!p || !p.review) throw new HttpError(404, "Advisory not found");
    if (p.review.state !== "OPERATOR" || p.status !== "PENDING") throw new HttpError(409, "Already handled");
    const at = new Date().toISOString();
    if (action === "SEND") {
      const chance = p.review.probability !== undefined ? `${Math.round(p.review.probability * 100)}% chance of rain. ` : "";
      const msg = note?.trim() ? note.trim() : `${chance}We've prepared a plan B — tap to use it.`;
      p.review = { ...p.review, state: "SENT", note: msg, by: actorOf(user), at };
      p.context = msg;
      log(db, p.tripId, actorOf(user), `Sent weather advisory: ${p.headline}`);
    } else {
      p.review = { ...p.review, state: "DISMISSED", by: actorOf(user), at };
      p.status = "DISMISSED";
      p.decidedBy = actorOf(user);
      p.decidedAt = at;
      log(db, p.tripId, actorOf(user), `Kept weather advisory internal: ${p.headline}`);
    }
    return p;
  });
  publish({ type: "proposal.changed", tripId: out.tripId, proposalId: out.id });
  return { state: out.review!.state };
}
