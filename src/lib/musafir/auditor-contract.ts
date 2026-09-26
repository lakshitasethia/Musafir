/**
 * Contract for pure auditors (CLAUDE.md §5, §10). Auditors are written by Parth
 * in `src/lib/musafir/auditors/**` and registered in `src/server/auditors.ts`.
 * An auditor is a pure function of the day and the traveller's settings; it
 * may *suggest* patches, but only the trip service applies anything.
 */
import type { DaySchedule, TripPatch, VibeConfig } from "./schemas.ts";

export type AuditSeverity = "info" | "warn" | "block";

export interface AuditFinding {
  /** Stable auditor name, e.g. "pacing", "budget". */
  auditor: string;
  severity: AuditSeverity;
  nodeId?: string;
  message: string;
  /** Optional fix; goes through applyPatches + classifyRisk like any other change. */
  suggestion?: TripPatch[];
}

export interface AuditContext {
  day: DaySchedule;
  vibe: VibeConfig;
  dietaryRestrictions: readonly string[];
  /** Spending ceiling for the day in the day's currency, if the traveller set one. */
  budgetCeiling?: number;
}

export type Auditor = { name: string; run: (ctx: AuditContext) => AuditFinding[] };

/** Runs every auditor; one crashing auditor becomes an info finding, never a failed request. */
export function runAuditors(auditors: readonly Auditor[], ctx: AuditContext): AuditFinding[] {
  return auditors.flatMap((a) => {
    try {
      return a.run(ctx).map((f) => ({ ...f, auditor: a.name }));
    } catch (e) {
      return [{ auditor: a.name, severity: "info" as const, message: `Auditor unavailable: ${(e as Error).message}` }];
    }
  });
}
