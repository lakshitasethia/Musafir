import { test } from "node:test";
import assert from "node:assert/strict";
import { openStatus, parseOpeningHours, weekdayIndex } from "./opening-hours.ts";

const MON = "2026-09-28"; // a Monday
const SAT = "2026-10-03";
const SUN = "2026-10-04";
const t = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

test("weekdayIndex: Monday is 0", () => {
  assert.equal(weekdayIndex(MON), 0);
  assert.equal(weekdayIndex(SUN), 6);
});

test("common forms: 24/7, day ranges, several time ranges", () => {
  assert.equal(openStatus("24/7", MON, t("03:00"), t("04:00")), "open");
  const oh = "Mo-Fr 09:00-17:00; Sa 10:00-14:00";
  assert.equal(openStatus(oh, MON, t("10:00"), t("11:30")), "open");
  assert.equal(openStatus(oh, MON, t("16:30"), t("17:30")), "closed"); // runs past closing
  assert.equal(openStatus(oh, SAT, t("15:00"), t("16:00")), "closed");
  assert.equal(openStatus(oh, SUN, t("10:00"), t("11:00")), "unknown"); // Sunday not described
  const split = "Mo,We,Fr 09:00-12:00,14:00-18:00";
  assert.equal(openStatus(split, MON, t("12:30"), t("13:30")), "closed");
  assert.equal(openStatus(split, MON, t("14:00"), t("15:00")), "open");
  assert.equal(openStatus("10:00-22:00", SUN, t("20:00"), t("21:00")), "open"); // no days = every day
});

test("off days, overrides and past midnight", () => {
  assert.equal(openStatus("Tu-Su 10:00-17:00; Mo off", MON, t("11:00"), t("12:00")), "closed");
  assert.equal(openStatus("Mo-Su 09:00-18:00; Su 12:00-16:00", SUN, t("10:00"), t("11:00")), "closed"); // later rule wins
  const late = "Fr-Sa 18:00-02:00";
  assert.equal(openStatus(late, SAT, t("23:00"), t("23:59")), "open");
  assert.equal(openStatus(late, SUN, t("00:30"), t("01:30")), "open"); // Saturday's hours spill into Sunday
});

test("unsupported syntax is unknown, never closed", () => {
  for (const oh of ["sunrise-sunset", "Jan-Mar Mo-Fr 09:00-17:00", "Mo-Fr 09:00-17:00 \"by appointment\"", "week 01-10 Mo 09:00-12:00", ""]) {
    assert.equal(openStatus(oh, MON, t("10:00"), t("11:00")), "unknown", oh);
  }
  assert.equal(openStatus(undefined, MON, 600, 660), "unknown");
  assert.equal(openStatus("Su,PH off; Mo-Sa 10:00-20:00", MON, t("11:00"), t("12:00")), "open"); // PH ignored, not fatal
  assert.equal(parseOpeningHours("closed")?.every((d) => d?.length === 0), true);
});
