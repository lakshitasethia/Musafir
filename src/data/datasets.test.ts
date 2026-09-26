import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EmergencyNumbersFileSchema, PlugTypesFileSchema, TippingFileSchema, WeatherImpactClassesSchema } from "./schema.ts";

const load = (name: string): unknown => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));
// the latest calendar date anywhere right now (UTC+14), so a date checked in a timezone ahead of UTC still passes
const today = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);

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

// ── weather-impact-classes.json ─────────────────────────────────────
const round1 = (x: number) => Math.round(x * 10) / 10;

test("data: weather-impact-classes matches its schema, is dated and sourced", () => {
  const d = WeatherImpactClassesSchema.parse(load("weather-impact-classes.json"));
  assert.ok(d.checkedOn <= today);
  for (const sec of [d.rainRate, d.heatIndex, d.wind]) {
    for (const c of sec.classes) assert.ok(c.source < sec.sources.length, `${c.key} cites a missing source`);
    for (const s of sec.sources) assert.ok(s.url.startsWith("https://"));
  }
});

test("data: weather classes are ordered, non-overlapping, and conversions are exact", () => {
  const d = WeatherImpactClassesSchema.parse(load("weather-impact-classes.json"));
  const ascending = (xs: number[]) => xs.every((x, i) => i === 0 || x > xs[i - 1]);
  assert.ok(ascending(d.rainRate.classes.map((c) => c.minMmPerHour)));
  assert.ok(ascending(d.heatIndex.classes.map((c) => c.minF)));
  assert.ok(ascending(d.wind.classes.map((c) => c.force)));
  for (const c of d.heatIndex.classes) {
    assert.equal(c.minC, round1(((c.minF - 32) * 5) / 9), `${c.key} minC`);
    if (c.maxF !== null) assert.equal(c.maxC, round1(((c.maxF - 32) * 5) / 9), `${c.key} maxC`);
  }
  for (const c of d.wind.classes) {
    assert.equal(c.minKmh, round1(c.minKnots * 1.852), `${c.key} minKmh`);
    if (c.maxKnots !== null) assert.equal(c.maxKmh, round1(c.maxKnots * 1.852), `${c.key} maxKmh`);
  }
});

test("data: weather classes carry the twin's keys and the cited values", () => {
  const d = WeatherImpactClassesSchema.parse(load("weather-impact-classes.json"));
  const rain = Object.fromEntries(d.rainRate.classes.map((c) => [c.key, c]));
  assert.equal(rain["rain:light"].maxMmPerHour, 2.5); // AMS: 0.25 cm/h
  assert.equal(rain["rain:heavy"].minMmPerHour, 7.6); // AMS: over 0.76 cm/h
  assert.equal(rain["rain:violent"].minMmPerHour, 50); // WMO: violent showers
  const heat = Object.fromEntries(d.heatIndex.classes.map((c) => [c.key, c]));
  assert.deepEqual([heat["heat:caution"].minF, heat["heat:extreme"].minF, heat["heat:danger"].minF], [80, 90, 103]);
  const wind = Object.fromEntries(d.wind.classes.map((c) => [c.key, c]));
  assert.equal(wind["gust:gale"].force, 7);
  assert.equal(wind["gust:strong"].force, 9);
});
