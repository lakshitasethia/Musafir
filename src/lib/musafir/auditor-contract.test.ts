import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuditors, type Auditor } from "./auditor-contract.ts";
import { DayScheduleSchema } from "./schemas.ts";

const ctx = {
  day: DayScheduleSchema.parse({ dayIndex: 1, date: "2026-09-26", nodes: [], transitSegments: [], dailyFatigueScore: 0 }),
  vibe: { pacing: 0.5, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 },
  dietaryRestrictions: [],
};

test("runAuditors tags findings with the auditor name and isolates crashes", () => {
  const ok: Auditor = { name: "ok", run: () => [{ auditor: "spoofed", severity: "warn", message: "long day" }] };
  const bad: Auditor = { name: "bad", run: () => { throw new Error("boom"); } };
  const out = runAuditors([ok, bad], ctx);
  assert.deepEqual(out.map((f) => [f.auditor, f.severity]), [["ok", "warn"], ["bad", "info"]]);
  assert.deepEqual(runAuditors([], ctx), []);
});
