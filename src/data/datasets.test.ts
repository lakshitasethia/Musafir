import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EmergencyNumbersFileSchema, PlugTypesFileSchema, TippingFileSchema } from "./schema.ts";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
const today = new Date().toISOString().slice(0, 10);

const files = [
  { name: "emergency-numbers.json", schema: EmergencyNumbersFileSchema },
  { name: "plug-types.json", schema: PlugTypesFileSchema },
  { name: "tipping.json", schema: TippingFileSchema },
] as const;

for (const { name, schema } of files) {
  test(`data: ${name} matches its schema`, () => {
    schema.parse(load(name));
  });

  test(`data: ${name} is dated, sourced, and has no invented fill-ins`, () => {
    const data = schema.parse(load(name));
    for (const entry of data.entries) {
      assert.ok(entry.checkedOn <= today, `${entry.country}: checkedOn ${entry.checkedOn} is in the future`);
      assert.ok(!Number.isNaN(Date.parse(entry.checkedOn)), `${entry.country}: bad date ${entry.checkedOn}`);
      for (const s of entry.sources) assert.ok(!/example\.|localhost/.test(s.url), `${entry.country}: placeholder source ${s.url}`);
    }
    for (const gap of data.gaps) assert.ok(gap.checkedOn <= today);
  });
}

test("data: emergency numbers are unique per country", () => {
  const data = EmergencyNumbersFileSchema.parse(load("emergency-numbers.json"));
  const keys = data.entries.map((e) => `${e.country}:${e.number}`);
  assert.equal(new Set(keys).size, keys.length);
});

test("data: every emergency-number country has a number for emergencies", () => {
  const data = EmergencyNumbersFileSchema.parse(load("emergency-numbers.json"));
  const emergency = new Set(["ALL", "POLICE", "FIRE", "AMBULANCE"]);
  for (const country of new Set(data.entries.map((e) => e.country))) {
    const covered = new Set(data.entries.filter((e) => e.country === country).flatMap((e) => e.services).filter((s) => emergency.has(s)));
    assert.ok(covered.has("ALL") || (covered.has("POLICE") && covered.has("FIRE") && covered.has("AMBULANCE")), `${country} lacks full emergency coverage`);
  }
});

test("data: a country is never both an entry and a gap in plug types", () => {
  const data = PlugTypesFileSchema.parse(load("plug-types.json"));
  const entries = new Set(data.entries.map((e) => e.country));
  for (const gap of data.gaps) assert.ok(!entries.has(gap.country), `${gap.country} is both an entry and a gap`);
});

test("data: schemas reject unsourced or undated entries", () => {
  const base = {
    country: "JP",
    countryName: "Japan",
    number: "110",
    services: ["POLICE"],
    label: "Police",
    checkedOn: "2026-09-26",
  };
  const file = (entry: object) => ({ dataset: "x", description: "x", entries: [entry], gaps: [] });
  assert.equal(EmergencyNumbersFileSchema.safeParse(file({ ...base, sources: [] })).success, false);
  const src = [{ url: "http://insecure.example", verification: "page-read", quote: "x" }];
  assert.equal(EmergencyNumbersFileSchema.safeParse(file({ ...base, sources: src })).success, false);
  const ok = [{ url: "https://www.japan.travel/en/plan/emergencies/", verification: "page-read", quote: "Police: 110" }];
  assert.equal(EmergencyNumbersFileSchema.safeParse(file({ ...base, checkedOn: "26/09/2026", sources: ok })).success, false);
  assert.equal(EmergencyNumbersFileSchema.safeParse(file({ ...base, sources: ok })).success, true);
});
