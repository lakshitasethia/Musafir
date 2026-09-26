/**
 * Dietary match from OpenStreetMap `diet:*` tags only. Never asserts safety.
 *
 * Source of truth: https://wiki.openstreetmap.org/wiki/Key:diet (checked 2026-09-26)
 *  - `yes`  = "the place provides at least a proper choice for this diet type"
 *  - `only` = "the place only provides this diet type"
 *  - `no`   = "doesn't provide this diet type at all, or not reliably"
 *  - `limited` is discussed on the wiki but flagged as a tagging mistake, so it
 *    (and any other value) is treated as unverified.
 *
 * A requirement is:
 *  - VERIFIED   when the venue's tag says `yes`/`only`
 *  - CONFLICT   when it says `no`
 *  - UNVERIFIED when the tag is missing or non-standard, or when OSM has no tag
 *    for that need at all (e.g. Jain food, nut allergies)
 *
 * Inference is limited to strict logical implications and is labelled as such:
 * a vegan choice is a vegetarian and a dairy-free choice, lacto/ovo-vegetarian
 * choices are vegetarian, and a place with no vegetarian choice has no vegan one.
 */

export const DIET_KEYS = [
  "vegetarian",
  "vegan",
  "halal",
  "kosher",
  "gluten_free",
  "lactose_free",
  "dairy_free",
  "pescetarian",
  "lacto_vegetarian",
  "ovo_vegetarian",
  "sugar_free",
  "alcohol_free",
  "keto",
  "raw",
  "fruitarian",
] as const;
export type DietKey = (typeof DIET_KEYS)[number];

/** Keys where getting it wrong can make someone ill; the label always says to confirm. */
const ALLERGY_LIKE: ReadonlySet<DietKey> = new Set(["gluten_free", "lactose_free", "dairy_free", "sugar_free"]);

/** What travellers type (trip.dietaryRestrictions) → OSM key. Matched case-insensitively. */
const ALIASES: Record<string, DietKey> = {
  veg: "vegetarian",
  "pure veg": "vegetarian",
  veggie: "vegetarian",
  vegetarian: "vegetarian",
  "no meat": "vegetarian",
  vegan: "vegan",
  "plant based": "vegan",
  "plant-based": "vegan",
  halal: "halal",
  kosher: "kosher",
  "gluten free": "gluten_free",
  "no gluten": "gluten_free",
  celiac: "gluten_free",
  coeliac: "gluten_free",
  "lactose free": "lactose_free",
  "lactose intolerant": "lactose_free",
  "dairy free": "dairy_free",
  "no dairy": "dairy_free",
  pescetarian: "pescetarian",
  pescatarian: "pescetarian",
  "lacto vegetarian": "lacto_vegetarian",
  "ovo vegetarian": "ovo_vegetarian",
  // the wiki defines diet:sugar_free as "no added sugar nor refined carbs for diabetics"
  diabetic: "sugar_free",
  "sugar free": "sugar_free",
  "no sugar": "sugar_free",
  "alcohol free": "alcohol_free",
  "no alcohol": "alcohol_free",
  keto: "keto",
  raw: "raw",
  fruitarian: "fruitarian",
};

export function dietKeyFor(requirement: string): DietKey | null {
  const text = requirement.toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
  return ALIASES[text] ?? ALIASES[text.replace(/ /g, "-")] ?? null;
}

export type DietStatus = "VERIFIED" | "CONFLICT" | "UNVERIFIED";

export interface DietCheck {
  /** What the traveller asked for, as typed. */
  requirement: string;
  /** The OSM key it maps to, or null when OSM has no tag for it. */
  key: DietKey | null;
  status: DietStatus;
  /** The tag that decided it, e.g. "diet:vegan=only". */
  evidence?: string;
  /** True when the status follows logically from another tag rather than its own. */
  inferred?: boolean;
  detail: string;
}

export interface DietReport {
  verdict: DietStatus | "NO_REQUIREMENTS";
  checks: DietCheck[];
  /** Short label for a card. Never claims a place is safe. */
  label: string;
  /** Always shown when there are requirements. */
  disclaimer: string;
}

type Value = "yes" | "only" | "no";

function tagValue(tags: Readonly<Record<string, string | undefined>>, key: DietKey): { value: Value | "other"; raw: string } | null {
  const raw = tags[`diet:${key}`]?.trim().toLowerCase();
  if (raw) return { value: raw === "yes" || raw === "only" || raw === "no" ? raw : "other", raw };
  // cuisine=vegetarian / cuisine=vegan (a semicolon list) is older tagging for a dedicated place
  if (key === "vegetarian" || key === "vegan") {
    const cuisines = (tags.cuisine ?? "").toLowerCase().split(";").map((c) => c.trim());
    if (cuisines.includes(key)) return { value: "yes", raw: `cuisine=${key}` };
  }
  return null;
}

const DISPLAY: Record<DietKey, string> = {
  vegetarian: "vegetarian",
  vegan: "vegan",
  halal: "halal",
  kosher: "kosher",
  gluten_free: "gluten-free",
  lactose_free: "lactose-free",
  dairy_free: "dairy-free",
  pescetarian: "pescetarian",
  lacto_vegetarian: "lacto-vegetarian",
  ovo_vegetarian: "ovo-vegetarian",
  sugar_free: "sugar-free",
  alcohol_free: "alcohol-free",
  keto: "keto",
  raw: "raw",
  fruitarian: "fruitarian",
};

/** Other tags that settle `key` by strict implication: [source key, source value, implied value]. */
const IMPLICATIONS: Partial<Record<DietKey, [DietKey, Value, Value][]>> = {
  vegetarian: [
    ["vegan", "only", "only"],
    ["vegan", "yes", "yes"],
    ["lacto_vegetarian", "only", "only"],
    ["lacto_vegetarian", "yes", "yes"],
    ["ovo_vegetarian", "only", "only"],
    ["ovo_vegetarian", "yes", "yes"],
  ],
  dairy_free: [
    ["vegan", "only", "only"],
    ["vegan", "yes", "yes"],
  ],
  vegan: [["vegetarian", "no", "no"]],
};

function describe(key: DietKey, value: Value, evidence: string, inferred: boolean): string {
  const name = DISPLAY[key];
  const via = inferred ? ` (inferred from ${evidence})` : "";
  if (value === "only") return `Serves only ${name} food, per OpenStreetMap${via}.`;
  if (value === "yes") return `Lists a proper ${name} choice, per OpenStreetMap${via}.`;
  return `Listed as not offering ${name} food, per OpenStreetMap${via}.`;
}

function checkOne(requirement: string, tags: Readonly<Record<string, string | undefined>>): DietCheck {
  const key = dietKeyFor(requirement);
  if (!key) {
    return {
      requirement,
      key: null,
      status: "UNVERIFIED",
      detail: `OpenStreetMap has no tag for "${requirement}"; ask the venue.`,
    };
  }
  const own = tagValue(tags, key);
  if (own && own.value !== "other") {
    const evidence = own.raw.startsWith("cuisine=") ? own.raw : `diet:${key}=${own.value}`;
    return { requirement, key, status: own.value === "no" ? "CONFLICT" : "VERIFIED", evidence, detail: describe(key, own.value, evidence, false) };
  }
  for (const [srcKey, srcValue, implied] of IMPLICATIONS[key] ?? []) {
    const src = tagValue(tags, srcKey);
    if (src?.value === srcValue) {
      const evidence = src.raw.startsWith("cuisine=") ? src.raw : `diet:${srcKey}=${srcValue}`;
      return { requirement, key, status: implied === "no" ? "CONFLICT" : "VERIFIED", evidence, inferred: true, detail: describe(key, implied, evidence, true) };
    }
  }
  if (own) {
    return { requirement, key, status: "UNVERIFIED", evidence: `diet:${key}=${own.raw}`, detail: `Tagged "${own.raw}", which isn't a standard value; ask the venue.` };
  }
  return { requirement, key, status: "UNVERIFIED", detail: `No ${DISPLAY[key]} information in OpenStreetMap; ask the venue.` };
}

/**
 * Checks a venue's OSM tags against the traveller's dietary requirements.
 * Duplicate or blank requirements are ignored; input is never mutated.
 */
export function auditDiet(tags: Readonly<Record<string, string | undefined>>, requirements: readonly string[]): DietReport {
  const seen = new Set<string>();
  const unique = requirements
    .map((r) => r.trim())
    .filter((r) => r && !seen.has(r.toLowerCase()) && seen.add(r.toLowerCase()));
  if (unique.length === 0) {
    return { verdict: "NO_REQUIREMENTS", checks: [], label: "", disclaimer: "" };
  }
  const checks = unique.map((r) => checkOne(r, tags));
  const verdict: DietStatus = checks.some((c) => c.status === "CONFLICT")
    ? "CONFLICT"
    : checks.some((c) => c.status === "UNVERIFIED")
      ? "UNVERIFIED"
      : "VERIFIED";
  const names = (s: DietStatus) => checks.filter((c) => c.status === s).map((c) => (c.key ? DISPLAY[c.key] : c.requirement));
  const label =
    verdict === "CONFLICT"
      ? `Listed as not ${names("CONFLICT").join(", ")}`
      : verdict === "UNVERIFIED"
        ? `Diet unverified: ${names("UNVERIFIED").join(", ")}`
        : `${names("VERIFIED").join(", ")} listed`;
  const allergy = checks.some((c) => c.key && ALLERGY_LIKE.has(c.key));
  const disclaimer = allergy
    ? "From OpenStreetMap tags, which anyone can edit. For allergies or intolerances, always confirm with the venue."
    : "From OpenStreetMap tags, which anyone can edit. Confirm with the venue.";
  return { verdict, checks, label: label.charAt(0).toUpperCase() + label.slice(1), disclaimer };
}
