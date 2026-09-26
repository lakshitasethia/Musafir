/**
 * Auditor registry (Aryan wires, Parth writes). Each entry adapts one of
 * Parth's pure auditors in `src/lib/musafir/auditors/` to the per-day
 * contract; findings are shown per day in the trip view. Nothing is faked:
 * auditors that need data we don't have yet (budget ceilings, hourly
 * heat/UV) stay silent instead of guessing.
 */
import { runAuditors, type AuditFinding, type AuditSeverity, type Auditor } from "@/lib/musafir/auditor-contract.ts";
import type { Severity } from "@/lib/musafir/auditors/finding.ts";
import { checkVisit } from "@/lib/musafir/auditors/openingHours.ts";
import { auditPacing } from "@/lib/musafir/auditors/pacing.ts";
import type { TripState } from "@/lib/musafir/schemas.ts";
import { MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";

const SEVERITY: Record<Severity, AuditSeverity> = { INFO: "info", WARN: "warn", ALERT: "block" };

const pacing: Auditor = {
  name: "pacing",
  run: ({ day, vibe }) =>
    day.nodes.length === 0
      ? []
      : auditPacing({ day, vibe }).findings.map((f) => ({ auditor: "pacing", severity: SEVERITY[f.severity], nodeId: f.nodeId, message: f.message })),
};

/** Flags visits the venue's listed hours rule out. Unknown or unreadable hours stay quiet (no guessing). */
const openingHours: Auditor = {
  name: "opening hours",
  run: ({ day }) =>
    day.nodes.flatMap((n) => {
      const hours = typeof n.metadata?.openingHours === "string" ? n.metadata.openingHours : undefined;
      if (!hours || toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes > MINUTES_PER_DAY) return [];
      const v = checkVisit(hours, day.date, n.timeSlot.start, n.timeSlot.durationMinutes);
      if (v.status !== "CLOSED" && v.status !== "PARTIAL") return [];
      return [{ auditor: "opening hours", severity: "warn" as const, nodeId: n.id, message: `${n.title}: ${v.reason}${v.caveat ? ` ${v.caveat}` : ""}` }];
    }),
};

export const AUDITORS: Auditor[] = [pacing, openingHours];

export function auditTrip(trip: TripState): Record<number, AuditFinding[]> {
  return Object.fromEntries(
    trip.schedule.map((day) => [day.dayIndex, runAuditors(AUDITORS, { day, vibe: trip.vibeConfig, dietaryRestrictions: trip.dietaryRestrictions })]),
  );
}
