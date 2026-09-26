import { test } from "node:test";
import assert from "node:assert/strict";
import { checkVisit, intervalsOn, parseOpeningHours, weekdayOf, type ParsedHours } from "./openingHours.ts";

// 2026-10-05 is a Monday.
const MON = "2026-10-05";
const FRI = "2026-10-09";
const SAT = "2026-10-10";
const SUN = "2026-10-11";

function ok(value: string): Extract<ParsedHours, { ok: true }> {
  const p = parseOpeningHours(value);
  assert.ok(p.ok, `expected "${value}" to parse, got: ${!p.ok && p.reason}`);
  return p;
}
const hours = (value: string, weekday: number) => intervalsOn(ok(value), weekday).map((iv) => [iv.from, iv.to]);

test("openingHours: weekdayOf uses Monday = 0 and rejects impossible dates", () => {
  assert.equal(weekdayOf(MON), 0);
  assert.equal(weekdayOf(SUN), 6);
  assert.throws(() => weekdayOf("2026-02-30"), RangeError);
  assert.throws(() => weekdayOf("5 Oct 2026"), RangeError);
});

test("openingHours: 24/7, plain spans and rules without a weekday selector", () => {
  assert.deepEqual(hours("24/7", 3), [[0, 1440]]);
  assert.deepEqual(hours("09:00-17:00", 6), [[540, 1020]]);
  assert.deepEqual(hours("Mo-Su 00:00-24:00", 2), [[0, 1440]]);
});

test("openingHours: weekday ranges, wrapping ranges, lists and split spans", () => {
  assert.deepEqual(hours("Mo-Fr 09:00-17:00", 4), [[540, 1020]]);
  assert.deepEqual(hours("Mo-Fr 09:00-17:00", 5), []);
  assert.deepEqual(hours("Sa-Mo 10:00-14:00", 0), [[600, 840]]);
  assert.deepEqual(hours("Sa-Mo 10:00-14:00", 1), []);
  assert.deepEqual(hours("Mo,We,Fr 08:00-12:00", 2), [[480, 720]]);
  assert.deepEqual(hours("Mo-Sa 09:00-13:00,16:00-20:00", 5), [[540, 780], [960, 1200]]);
});

test("openingHours: later normal rules replace, additional rules add, off cuts", () => {
  assert.deepEqual(hours("Mo-Su 09:00-18:00; Su 10:00-14:00", 6), [[600, 840]]);
  assert.deepEqual(hours("Mo-Su 09:00-18:00; Su 10:00-14:00", 5), [[540, 1080]]);
  assert.deepEqual(hours("Mo-Sa 09:00-21:00; Su off", 6), []);
  assert.deepEqual(hours("Mo-Fr 10:00-18:00, Sa 10:00-14:00", 5), [[600, 840]]);
  assert.deepEqual(hours("Mo-Fr 09:00-18:00, We 12:00-13:00 off", 2), [[540, 720], [780, 1080]]);
  assert.deepEqual(hours("Mo-Fr 09:00-18:00; We closed", 2), []);
});

test("openingHours: overnight spans belong to the start day and spill into the next", () => {
  // Fr 22:00-02:00 → Friday 22:00-24:00 and Saturday 00:00-02:00.
  assert.deepEqual(hours("Fr 22:00-02:00", 4), [[1320, 1440]]);
  assert.deepEqual(hours("Fr 22:00-02:00", 5), [[0, 120]]);
  assert.deepEqual(hours("Fr 22:00-26:00", 5), [[0, 120]]);
  // Sunday's spill wraps to Monday.
  assert.deepEqual(hours("Su 20:00-01:00", 0), [[0, 60]]);
  // "Sa off" removes Saturday's own hours, not Friday's night that runs into it.
  assert.deepEqual(hours("Fr,Sa 22:00-02:00; Sa off", 5), [[0, 120]]);
});

test("openingHours: messy real-world spacing, dashes and lower case are normalised", () => {
  assert.deepEqual(hours("mo - fr 9:00 – 17:30", 0), [[540, 1050]]);
  assert.deepEqual(hours("Mo-Fr 09:00-17:00 , Sa 10:00-12:00", 5), [[600, 720]]);
});

test("openingHours: holiday rules are skipped with a caveat, not guessed", () => {
  const p = ok("Mo-Fr 09:00-17:00; PH off");
  assert.equal(p.holidayRulesSkipped, true);
  assert.deepEqual(intervalsOn(p, 0).map((iv) => [iv.from, iv.to]), [[540, 1020]]);
  assert.equal(checkVisit("24/7; PH off", MON, "10:00", 60).caveat, "Hours may differ on public holidays.");
});

test("openingHours: unsupported or incomplete values are UNKNOWN, never guessed", () => {
  for (const value of [
    "",
    "   ",
    "sunrise-sunset",
    "Mo-Fr 10:00+",
    "Jan-Mar Mo-Fr 09:00-17:00",
    "Mo[1] 09:00-12:00",
    'Mo-Fr 09:00-17:00 "call ahead"',
    "Mo-Fr 09:00-17:00 || closed",
    "Mo-Fr",
    "Mo-Fr 9h-17h",
    "Mo-Fr 09:00-09:00",
    "Mo-Fr 25:00-26:00",
    "Mo-Fr 09:00-17:00 13:00-14:00",
    "Mo-Fr 10:00-18:00,Sa,Su 10:00-14:00",
  ]) {
    assert.equal(parseOpeningHours(value).ok, false, `"${value}" should be unknown`);
  }
  assert.equal(parseOpeningHours(undefined).ok, false);
});

test("checkVisit: OPEN, CLOSED and PARTIAL with the day's hours", () => {
  const value = "Mo-Fr 09:00-17:00; Sa 10:00-14:00";
  const open = checkVisit(value, MON, "10:00", 90);
  assert.equal(open.status, "OPEN");
  assert.deepEqual(open.openHours, ["09:00–17:00"]);

  const sunday = checkVisit(value, SUN, "10:00", 60);
  assert.equal(sunday.status, "CLOSED");
  assert.match(sunday.reason, /closed on Su/);

  assert.equal(checkVisit(value, MON, "18:00", 60).status, "CLOSED");
  assert.match(checkVisit(value, SAT, "13:00", 90).reason, /Closes before the visit ends/);
  assert.match(checkVisit(value, SAT, "09:30", 60).reason, /Opens after the visit starts/);
  assert.equal(checkVisit("Fr 20:00-02:00", SAT, "00:30", 60).status, "OPEN");
  assert.equal(checkVisit("24/7", FRI, "00:00", 1440).status, "OPEN");
});

test("checkVisit: missing or unreadable hours are UNKNOWN with the raw value quoted", () => {
  assert.equal(checkVisit(undefined, MON, "10:00", 60).status, "UNKNOWN");
  const odd = checkVisit("sunrise-sunset", MON, "10:00", 60);
  assert.equal(odd.status, "UNKNOWN");
  assert.match(odd.reason, /"sunrise-sunset"/);
});

test("checkVisit: invalid input throws instead of wrapping past midnight", () => {
  assert.throws(() => checkVisit("24/7", MON, "23:30", 60), RangeError);
  assert.throws(() => checkVisit("24/7", MON, "25:00", 60), RangeError);
  assert.throws(() => checkVisit("24/7", MON, "10:00", 0), RangeError);
  assert.throws(() => checkVisit("24/7", "2026-13-01", "10:00", 30), RangeError);
});
