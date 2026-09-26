/**
 * Auditor registry (Aryan wires, Parth writes). When Parth adds auditors in
 * `src/lib/musafir/auditors/` (pacing, budget, diet, openingHours), import them
 * here and append to AUDITORS. Until then the list is empty and the UI simply
 * shows no findings — nothing is faked.
 */
import { runAuditors, type AuditFinding, type Auditor } from "@/lib/musafir/auditor-contract.ts";
import type { TripState } from "@/lib/musafir/schemas.ts";

export const AUDITORS: Auditor[] = [];

export function auditTrip(trip: TripState): Record<number, AuditFinding[]> {
  return Object.fromEntries(
    trip.schedule.map((day) => [day.dayIndex, runAuditors(AUDITORS, { day, vibe: trip.vibeConfig, dietaryRestrictions: trip.dietaryRestrictions })]),
  );
}
