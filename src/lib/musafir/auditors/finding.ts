/**
 * Shared shape for auditor output. Auditors are pure code critics: they read a
 * plan (plus optional sensor data passed in by the caller) and return findings.
 * They never fetch, never mutate their inputs and never produce TripPatches;
 * the trip service decides what to do with a finding.
 */

/** INFO: worth showing. WARN: the plan should probably change. ALERT: act before going. */
export type Severity = "INFO" | "WARN" | "ALERT";

export interface AuditFinding<Code extends string = string> {
  code: Code;
  severity: Severity;
  /** The stop the finding is about, when it is about one stop. */
  nodeId?: string;
  /** Calm, solution-first sentence for the traveller. */
  message: string;
}

const RANK: Record<Severity, number> = { INFO: 0, WARN: 1, ALERT: 2 };

export function worstSeverity(findings: readonly AuditFinding[]): Severity | null {
  let worst: Severity | null = null;
  for (const f of findings) if (worst === null || RANK[f.severity] > RANK[worst]) worst = f.severity;
  return worst;
}
