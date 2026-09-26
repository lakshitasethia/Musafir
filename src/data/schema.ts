/**
 * Contracts for the verified static datasets in src/data/*.json (CLAUDE.md §5, §10).
 *
 * Every fact carries where it came from. Rules:
 *  - Never LLM-generated. Every value is copied from the cited page.
 *  - `verification` says how the page was checked:
 *      "page-read"    — the page text was read directly on `checkedOn`.
 *      "search-index" — the official page blocks automated readers; the value was
 *                       confirmed from the search engine's copy of that page.
 *                       Re-check these in a browser before relying on them.
 *  - A fact that couldn't be verified is listed under `gaps`, never filled in.
 *
 * Pure: imports zod only, so auditors, _ui components and tests can all use it.
 */
import { z } from "zod";

const ISO_DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const COUNTRY = z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, upper case");

export const SourceSchema = z.object({
  url: z.url().startsWith("https://"),
  verification: z.enum(["page-read", "search-index"]),
  /** The words on the page that support the value (short, verbatim or near-verbatim). */
  quote: z.string().min(1).max(400),
});

const Base = z.object({
  country: COUNTRY,
  countryName: z.string().min(1),
  checkedOn: ISO_DATE,
  sources: z.array(SourceSchema).min(1),
});

export const GapSchema = z.object({
  country: COUNTRY,
  reason: z.string().min(1),
  checkedOn: ISO_DATE,
});

export const EmergencyNumberSchema = Base.extend({
  number: z.string().regex(/^\+?[0-9][0-9 -]*$/),
  services: z.array(z.enum(["POLICE", "FIRE", "AMBULANCE", "ALL", "NON_EMERGENCY_POLICE", "NON_EMERGENCY_MEDICAL", "TOURIST_HELPLINE"])).min(1),
  label: z.string().min(1),
  /** Where the number applies when narrower than the whole country, e.g. "Tokyo". */
  area: z.string().optional(),
  notes: z.string().optional(),
});

export const PlugTypeSchema = Base.extend({
  /** IEC letter designations, e.g. ["G"]. */
  plugTypes: z.array(z.string().regex(/^[A-N]$/)).min(1),
  voltageV: z.array(z.number().int().positive()).min(1),
  frequencyHz: z.array(z.union([z.literal(50), z.literal(60)])).min(1),
  notes: z.string().optional(),
});

export const TippingSchema = Base.extend({
  /** true / false when a source says so; null when only related rules (e.g. service charge) are sourced. */
  tippingExpected: z.boolean().nullable(),
  summary: z.string().min(1),
  serviceCharge: z.string().optional(),
});

const dataset = <T extends z.ZodType>(entry: T) =>
  z.object({
    dataset: z.string(),
    description: z.string(),
    entries: z.array(entry),
    gaps: z.array(GapSchema),
  });

export const EmergencyNumbersFileSchema = dataset(EmergencyNumberSchema);
export const PlugTypesFileSchema = dataset(PlugTypeSchema);
export const TippingFileSchema = dataset(TippingSchema);

export type Source = z.infer<typeof SourceSchema>;
export type EmergencyNumber = z.infer<typeof EmergencyNumberSchema>;
export type PlugType = z.infer<typeof PlugTypeSchema>;
export type Tipping = z.infer<typeof TippingSchema>;
export type DatasetGap = z.infer<typeof GapSchema>;

// ── weather-impact-classes.json (the Weather Digital Twin's cited thresholds) ──
const classSource = z.number().int().nonnegative(); // index into the section's `sources`
const nullableNumber = z.number().nullable();

const RainClassSchema = z.object({ key: z.string().startsWith("rain:"), label: z.string(), minMmPerHour: z.number().nonnegative(), maxMmPerHour: nullableNumber, source: classSource });
const HeatClassSchema = z.object({
  key: z.string().startsWith("heat:"),
  label: z.string(),
  minF: z.number(),
  maxF: nullableNumber,
  minC: z.number(),
  maxC: nullableNumber,
  effect: z.string().min(1),
  source: classSource,
});
const WindClassSchema = z.object({
  key: z.string().regex(/^(gust|beaufort):/),
  force: z.number().int().min(0).max(12),
  label: z.string(),
  minKnots: z.number().nonnegative(),
  maxKnots: nullableNumber,
  minKmh: z.number().nonnegative(),
  maxKmh: nullableNumber,
  source: classSource,
});
const section = <T extends z.ZodType>(cls: T) =>
  z.object({ unit: z.string(), note: z.string().min(1), classes: z.array(cls).min(1), sources: z.array(SourceSchema).min(1) });

export const WeatherImpactClassesSchema = z.object({
  dataset: z.literal("weather-impact-classes"),
  description: z.string(),
  checkedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rainRate: section(RainClassSchema),
  heatIndex: section(HeatClassSchema),
  wind: section(WindClassSchema),
});
export type WeatherImpactClasses = z.infer<typeof WeatherImpactClassesSchema>;
