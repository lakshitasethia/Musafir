/**
 * Leaf agent: Alternative Finder (supervisor = this deterministic code).
 *
 * For a closed venue or an outdoor stop hit by rain:
 *   1. Overpass fetches real venues within 800 m (deterministic pre-filter,
 *      nearest 3, excluding the original).
 *   2. An LLM ranks those 3 using a context slice (< 600 tokens): slot time,
 *      neighbouring stops' coordinates, dietary constraints, vibe. It can only
 *      pick an index — it never invents venues, coordinates, times or prices.
 *      No key / failure → nearest candidate, labelled "ranked by distance".
 *   3. The pick becomes REMOVE + INSERT patches, which go through the same
 *      applyPatches validation and risk classifier as every other change.
 * Workers never talk to each other; results return to the trip service only.
 */
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import { MIN_CLUSTER_SAVING_MIN, pickClusterReplacement } from "@/lib/musafir/cluster.ts";
import { estimateLeg } from "@/lib/musafir/geo.ts";
import { applyPatches } from "@/lib/musafir/reducer.ts";
import { classifyRisk } from "@/lib/musafir/risk.ts";
import type { DaySchedule, ItineraryNode, TripPatch } from "@/lib/musafir/schemas.ts";
import { publish } from "./events.ts";
import { llmJson } from "./llm.ts";
import { nearbyCandidates, type VenueCandidate } from "./osm.ts";
import { cachedLeg, routedLookup, warmLegs } from "./routing.ts";
import { write, read, type ProposalOption, type ProposalRecord } from "./store.ts";

const SEARCH_RADIUS_M = 800;
const MAX_CANDIDATES = 3;
const MAX_TARGETS = 2;
const CLUSTER_RADIUS_M = 1500;
const CLUSTER_MAX_CANDIDATES = 40;

const RankSchema = z.object({
  choice: z.number().int().min(0),
  rationale: z.string().min(1).max(300),
});

async function rank(
  node: ItineraryNode,
  day: DaySchedule,
  candidates: VenueCandidate[],
  why: string,
  prefs: { dietary: string[]; budget: number; culturalDepth: number },
): Promise<{ index: number; rationale: string; rankedBy: string }> {
  const idx = day.nodes.findIndex((n) => n.id === node.id);
  const near = (n?: ItineraryNode) => (n ? { title: n.title, lat: +n.location.lat.toFixed(4), lng: +n.location.lng.toFixed(4) } : null);
  const slice = {
    reason: why,
    replacing: { title: node.title, category: node.category, start: node.timeSlot.start, minutes: node.timeSlot.durationMinutes },
    previousStop: near(day.nodes[idx - 1]),
    nextStop: near(day.nodes[idx + 1]),
    dietary: prefs.dietary,
    budget01: prefs.budget,
    culturalDepth01: prefs.culturalDepth,
    candidates: candidates.map((c, i) => ({
      i,
      name: c.nameEn ?? c.name,
      kind: c.kind,
      metersAway: c.distanceMeters,
      openingHours: c.openingHours ?? "unknown",
      cuisine: c.cuisine,
      wheelchair: c.wheelchair,
    })),
  };
  const res = await llmJson({
    tier: "fast",
    timeoutMs: 5000,
    schema: RankSchema,
    system:
      'You rank replacement venues for a traveller. Choose exactly one candidate by index. Prefer venues likely open at the slot time, matching the replaced stop\'s purpose and the traveller\'s constraints. Never invent venues or facts. Reply as JSON: {"choice": <index>, "rationale": "<one calm sentence for the traveller>"}',
    user: JSON.stringify(slice),
  });
  if (res.ok && res.value.choice < candidates.length) {
    return { index: res.value.choice, rationale: res.value.rationale, rankedBy: `llm:${res.via}` };
  }
  const c = candidates[0];
  return {
    index: 0,
    rationale: `Nearest open-data match, ${c.distanceMeters} m away${c.openingHours ? ` (hours: ${c.openingHours})` : ""}.`,
    rankedBy: `distance${res.ok ? "" : ` — AI ranking unavailable: ${res.reason}`}`,
  };
}

function replacementPatches(day: DaySchedule, node: ItineraryNode, c: VenueCandidate, why: string): TripPatch[] {
  const inserted: ItineraryNode = {
    id: newId(),
    type: "SOFT",
    title: c.nameEn ?? c.name,
    nativeTitle: c.nameEn ? c.name : undefined,
    category: c.category,
    location: { lat: c.lat, lng: c.lng, city: node.location.city },
    timeSlot: { ...node.timeSlot },
    isOutdoor: c.isOutdoor,
    costEstimate: { ...node.costEstimate },
    metadata: {
      source: c.source,
      osmId: c.osmId,
      costSource: "carried over from the replaced stop (no price data)",
      ...(c.openingHours ? { openingHours: c.openingHours } : {}),
      replacedNodeId: node.id,
    },
  };
  return [
    { patchId: newId(), targetDayIndex: day.dayIndex, operation: "REMOVE", nodeId: node.id, reason: `${why}: replace "${node.title}"` },
    { patchId: newId(), targetDayIndex: day.dayIndex, operation: "INSERT", payload: inserted, reason: `${why}: add "${inserted.title}"` },
  ];
}

async function setAgentState(proposalId: string, tripId: string, patch: Partial<ProposalRecord>) {
  await write((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    if (p) Object.assign(p, patch);
  });
  publish({ type: "proposal.changed", tripId, proposalId });
}

/** Runs after the HTTP response (via `after`). Never throws. */
export async function runAlternativeAgent(proposalId: string): Promise<void> {
  const start = await read((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    const rec = p && db.trips.find((t) => t.trip.id === p.tripId);
    return p && rec ? { p: structuredClone(p), rec: structuredClone(rec) } : null;
  });
  if (!start) return;
  const { p, rec } = start;
  if (p.disruption.kind !== "CLOSURE" && p.disruption.kind !== "WEATHER") return;

  await setAgentState(p.id, p.tripId, { agentStatus: "RUNNING", agentNote: "Searching OpenStreetMap within 800 m…" });
  try {
    const day = rec.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
    if (!day) throw new Error("day no longer exists");
    const why = p.disruption.kind === "WEATHER" ? "Rain" : "Venue closed";
    const targets = p.affectedNodeIds
      .map((id) => day.nodes.find((n) => n.id === id))
      .filter((n): n is ItineraryNode => !!n && n.type === "SOFT")
      .slice(0, MAX_TARGETS);
    if (targets.length === 0) {
      await setAgentState(p.id, p.tripId, { agentStatus: "DONE", agentNote: "No flexible stop to replace." });
      return;
    }

    const options: ProposalOption[] = [];
    const notes: string[] = [];
    for (const node of targets) {
      const purpose = p.disruption.kind === "WEATHER" ? "INDOOR" : node.category;
      const all = await nearbyCandidates(node.location, purpose, SEARCH_RADIUS_M);
      const candidates = all
        .filter((c) => c.name !== node.title && c.nameEn !== node.title && c.name !== node.nativeTitle && c.distanceMeters > 25)
        .slice(0, MAX_CANDIDATES);
      if (candidates.length === 0) {
        notes.push(`No ${purpose === "INDOOR" ? "indoor" : purpose.toLowerCase()} venues found near "${node.title}".`);
        continue;
      }
      const pick = await rank(node, day, candidates, why, {
        dietary: rec.trip.dietaryRestrictions,
        budget: rec.trip.vibeConfig.budget,
        culturalDepth: rec.trip.vibeConfig.culturalDepth,
      });
      const chosen = candidates[pick.index];
      const patches = replacementPatches(day, node, chosen, why);
      applyPatches(day, patches); // validate before offering
      options.push({
        id: newId(),
        label: `Swap "${node.title}" for ${chosen.nameEn ?? chosen.name} (${chosen.distanceMeters} m)`,
        source: "agent",
        patches,
        conflicts: [],
        risk: classifyRisk(day, patches, [], rec.autonomy),
        rankedBy: pick.rankedBy,
        rationale: pick.rationale,
      });
    }

    const note = [options.length ? `Found ${options.length} alternative${options.length > 1 ? "s" : ""}.` : "", ...notes].filter(Boolean).join(" ");
    const created = await write((db) => {
      const cur = db.proposals.find((x) => x.id === p.id);
      const trip = db.trips.find((t) => t.trip.id === p.tripId);
      if (!cur || !trip) return null;
      Object.assign(cur, { agentStatus: "DONE", agentNote: note || "Nothing found." });
      if (options.length === 0) return null;
      if (cur.status === "PENDING" && trip.trip.version === cur.baseVersion) {
        cur.options.push(...options);
        db.activity.push({ id: newId(), tripId: p.tripId, at: new Date().toISOString(), actor: "agent", message: `Suggested: ${options.map((o) => o.label).join("; ")}` });
        return null;
      }
      // The engine's fix was already applied (or the trip moved on): offer as a new card on the current plan.
      const fresh: ProposalRecord = {
        id: newId(),
        tripId: p.tripId,
        dayIndex: p.dayIndex,
        baseVersion: trip.trip.version,
        createdAt: new Date().toISOString(),
        createdBy: "agent",
        disruption: p.disruption,
        urgency: "RECOMMENDATION",
        headline: `Alternative for: ${p.headline}`,
        context: "Real venues nearby from OpenStreetMap.",
        options,
        status: "PENDING",
        agentStatus: "DONE",
        agentNote: note,
        affectedNodeIds: p.affectedNodeIds,
      };
      // Re-validate against the current day, since the plan changed since the agent started.
      const currentDay = trip.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
      fresh.options = fresh.options.filter((o) => {
        try {
          applyPatches(currentDay!, o.patches);
          o.risk = classifyRisk(currentDay!, o.patches, [], trip.autonomy);
          return true;
        } catch {
          return false;
        }
      });
      if (fresh.options.length === 0) return null;
      db.proposals.push(fresh);
      db.activity.push({ id: newId(), tripId: p.tripId, at: fresh.createdAt, actor: "agent", message: `Suggested: ${fresh.options.map((o) => o.label).join("; ")}` });
      return fresh.id;
    });
    publish({ type: "proposal.changed", tripId: p.tripId, proposalId: created ?? p.id });
  } catch (e) {
    await setAgentState(p.id, p.tripId, { agentStatus: "FAILED", agentNote: `Couldn't search for alternatives: ${(e as Error).message}` });
  }
}

/**
 * Cluster Nearby worker: replaces the destination of a commute-spike leg with a
 * similar real place near the previous stop, only if it genuinely saves time.
 */
export async function runClusterAgent(proposalId: string): Promise<void> {
  const start = await read((db) => {
    const p = db.proposals.find((x) => x.id === proposalId);
    const rec = p && db.trips.find((t) => t.trip.id === p.tripId);
    return p && rec ? { p: structuredClone(p), rec: structuredClone(rec) } : null;
  });
  if (!start) return;
  const { p, rec } = start;
  const trigger = p.disruption;
  if (trigger.kind !== "COMMUTE_SPIKE") return;
  const targetId = trigger.nodeId;
  try {
    const day = rec.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
    const idx = day?.nodes.findIndex((n) => n.id === targetId) ?? -1;
    if (!day || idx < 1) throw new Error("that stop has no previous stop to cluster around");
    const prev = day.nodes[idx - 1];
    const target = day.nodes[idx];
    const next = day.nodes[idx + 1];

    await setAgentState(p.id, p.tripId, { agentStatus: "RUNNING", agentNote: `Searching near "${prev.title}"…` });
    const venues = (await nearbyCandidates(prev.location, target.category, CLUSTER_RADIUS_M)).slice(0, CLUSTER_MAX_CANDIDATES);
    const candidates = venues.map((v) => ({ id: v.osmId, name: v.nameEn ?? v.name, lat: v.lat, lng: v.lng, venue: v }));
    await warmLegs([prev.location, target.location, ...(next ? [next.location] : []), ...candidates]).catch(() => undefined);
    const minutes = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => cachedLeg(a, b)?.durationMinutes ?? estimateLeg(a, b).durationMinutes;
    const choice = pickClusterReplacement(prev, target, next, candidates, day.nodes.map((n) => n.title), minutes);

    const option: ProposalOption | null = choice
      ? (() => {
          const patches = replacementPatches(day, target, choice.candidate.venue, "Commute spike");
          applyPatches(day, patches, { routed: routedLookup });
          return {
            id: newId(),
            label: `Swap "${target.title}" for ${choice.candidate.name} near ${prev.title} — saves ~${choice.saving} min`,
            source: "agent" as const,
            patches,
            conflicts: [],
            risk: classifyRisk(day, patches, [], rec.autonomy),
            rankedBy: "shortest total travel (deterministic)",
            rationale: `Travel around this stop drops from ${choice.before} to ${choice.after} min.`,
          };
        })()
      : null;

    await write((db) => {
      const cur = db.proposals.find((x) => x.id === p.id);
      const trip = db.trips.find((t) => t.trip.id === p.tripId);
      if (!cur || !trip) return;
      cur.agentStatus = "DONE";
      if (!option) {
        cur.agentNote = `No ${target.category.toLowerCase()} place near "${prev.title}" saves at least ${MIN_CLUSTER_SAVING_MIN} min.`;
        return;
      }
      if (cur.status !== "PENDING" || trip.trip.version !== cur.baseVersion) {
        cur.agentNote = "The plan changed while searching; ask again.";
        return;
      }
      cur.options.push(option);
      cur.agentNote = `Found a closer option (${venues[0]?.source ?? "open data"}).`;
      db.activity.push({ id: newId(), tripId: p.tripId, at: new Date().toISOString(), actor: "agent", message: `Suggested: ${option.label}` });
    });
    publish({ type: "proposal.changed", tripId: p.tripId, proposalId: p.id });
  } catch (e) {
    await setAgentState(p.id, p.tripId, { agentStatus: "FAILED", agentNote: `Couldn't search: ${(e as Error).message}` });
  }
}
