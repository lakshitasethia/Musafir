/**
 * Budget & Expense Auditor: sums KNOWN costs only. Open data has no prices, so
 * most planned stops carry `costEstimate.amount = 0` with a `metadata.costSource`
 * like "unknown (no price in open data)". Treating those zeros as "free" would
 * make every total look affordable, so they are counted separately and every
 * total is reported as a lower bound while unknowns remain.
 *
 * A cost is KNOWN when:
 *  - `metadata.costKnown === true`, or
 *  - `amount > 0` and `metadata.costSource` doesn't say the price is unknown, or
 *  - `amount === 0` and `metadata.costSource` says the stop is free.
 * `metadata.costKnown === false` always makes it UNKNOWN.
 *
 * Currencies are never converted: each is summed on its own, and costs in a
 * currency other than the budget's are reported, not counted against it.
 * Money is summed in integer hundredths to avoid floating-point drift.
 */
import type { AuditFinding } from "./finding.ts";
import type { DaySchedule, ItineraryNode } from "../schemas.ts";

/** Share of the budget at which known costs trigger a heads-up. Product policy, tune freely. */
export const NEAR_BUDGET_RATIO = 0.9;

const UNKNOWN_SOURCE = /unknown|no price|not known|unverified/i;
const FREE_SOURCE = /\b(free|no charge|no entry fee|complimentary)\b/i;

export function isCostKnown(node: Pick<ItineraryNode, "costEstimate" | "metadata">): boolean {
  const meta = node.metadata ?? {};
  if (meta.costKnown === true) return true;
  if (meta.costKnown === false) return false;
  const source = typeof meta.costSource === "string" ? meta.costSource : "";
  if (node.costEstimate.amount > 0) return !UNKNOWN_SOURCE.test(source);
  return FREE_SOURCE.test(source) && !UNKNOWN_SOURCE.test(source);
}

export interface CurrencyTotal {
  currency: string;
  /** Sum of known costs, rounded to 2 decimals. */
  amount: number;
  knownItems: number;
}

export interface DayBudget {
  dayIndex: number;
  date: string;
  totals: CurrencyTotal[];
  unknownNodeIds: string[];
}

export type BudgetCode = "UNKNOWN_COSTS" | "OVER_BUDGET" | "NEAR_BUDGET" | "OTHER_CURRENCY";

export interface BudgetReport {
  totals: CurrencyTotal[];
  days: DayBudget[];
  knownCount: number;
  unknownCount: number;
  /** True while any stop's cost is unknown: totals are "at least". */
  isLowerBound: boolean;
  findings: AuditFinding<BudgetCode>[];
}

export interface BudgetLimit {
  amount: number;
  currency: string;
}

const normCurrency = (c: string) => c.trim().toUpperCase();

function sumByCurrency(nodes: readonly ItineraryNode[]): CurrencyTotal[] {
  const cents = new Map<string, { cents: number; items: number }>();
  for (const n of nodes) {
    const cur = normCurrency(n.costEstimate.currency);
    const entry = cents.get(cur) ?? { cents: 0, items: 0 };
    entry.cents += Math.round(n.costEstimate.amount * 100);
    entry.items += 1;
    cents.set(cur, entry);
  }
  return [...cents.entries()]
    .map(([currency, v]) => ({ currency, amount: v.cents / 100, knownItems: v.items }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

const money = (amount: number, currency: string) => `${currency} ${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/**
 * Audits a trip's (or a single day's) known costs, optionally against a budget.
 * Throws RangeError on a nonsensical limit rather than reporting against it.
 */
export function auditBudget(schedule: readonly DaySchedule[], limit?: BudgetLimit): BudgetReport {
  if (limit && (!Number.isFinite(limit.amount) || limit.amount < 0 || !/^[A-Za-z]{3}$/.test(limit.currency.trim()))) {
    throw new RangeError(`Invalid budget limit ${JSON.stringify(limit)}`);
  }
  const allKnown: ItineraryNode[] = [];
  let unknownCount = 0;
  const days: DayBudget[] = schedule.map((day) => {
    const known = day.nodes.filter((n) => isCostKnown(n));
    const unknown = day.nodes.filter((n) => !isCostKnown(n));
    allKnown.push(...known);
    unknownCount += unknown.length;
    return { dayIndex: day.dayIndex, date: day.date, totals: sumByCurrency(known), unknownNodeIds: unknown.map((n) => n.id) };
  });
  const totals = sumByCurrency(allKnown);
  const findings: AuditFinding<BudgetCode>[] = [];
  const stops = allKnown.length + unknownCount;

  if (unknownCount > 0) {
    findings.push({
      code: "UNKNOWN_COSTS",
      severity: "INFO",
      message: `${unknownCount} of ${stops} stop${stops === 1 ? "" : "s"} ${unknownCount === 1 ? "has" : "have"} no price in open data, so totals are a minimum.`,
    });
  }

  if (limit) {
    const currency = normCurrency(limit.currency);
    const spent = totals.find((t) => t.currency === currency)?.amount ?? 0;
    const others = totals.filter((t) => t.currency !== currency);
    if (spent > limit.amount) {
      findings.push({
        code: "OVER_BUDGET",
        severity: "ALERT",
        message: `Known costs are ${money(spent, currency)}, ${money(Math.round((spent - limit.amount) * 100) / 100, currency)} over the ${money(limit.amount, currency)} budget.`,
      });
    } else if (limit.amount > 0 && spent >= limit.amount * NEAR_BUDGET_RATIO) {
      findings.push({
        code: "NEAR_BUDGET",
        severity: "WARN",
        message: `Known costs are ${money(spent, currency)} of the ${money(limit.amount, currency)} budget${unknownCount ? ", before the stops without prices" : ""}.`,
      });
    }
    if (others.length > 0) {
      findings.push({
        code: "OTHER_CURRENCY",
        severity: "WARN",
        message: `${others.map((t) => money(t.amount, t.currency)).join(" and ")} can't be counted against a budget in ${currency} without an exchange rate.`,
      });
    }
  }

  return { totals, days, knownCount: allKnown.length, unknownCount, isLowerBound: unknownCount > 0, findings };
}
