/**
 * English-first place names (pure). Travellers read English titles everywhere;
 * the local-script name is kept separately (Taxi card, driver hand-off). When
 * open data has no English/Latin name we say what the place *is* ("Café")
 * rather than transliterating or inventing a name.
 */
import type { NodeCategory } from "./schemas.ts";

/** True when most letters are Latin script (so an English reader can read and say it). */
export function isReadableLatin(s: string): boolean {
  const letters = [...s].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= 0.6;
}

const KIND_LABELS: [RegExp, string][] = [
  [/=cafe$/, "Café"],
  [/=restaurant$/, "Restaurant"],
  [/=(fast_food|food_court)$/, "Street-food stall"],
  [/=(bar|pub)$/, "Bar"],
  [/=ice_cream$/, "Ice-cream shop"],
  [/=museum$/, "Museum"],
  [/=gallery$/, "Art gallery"],
  [/=(temple|place_of_worship)$/, "Temple"],
  [/=(fort|castle)$/, "Fort"],
  [/=palace$/, "Palace"],
  [/=monument$/, "Monument"],
  [/=ruins$/, "Ruins"],
  [/=(park|nature_reserve)$/, "Park"],
  [/=garden$/, "Garden"],
  [/=viewpoint$/, "Viewpoint"],
  [/=(cinema|theatre|arts_centre)$/, "Arts venue"],
  [/=(mall|department_store)$/, "Shopping centre"],
  [/=marketplace$/, "Market"],
  [/=(hotel|guest_house|hostel)$/, "Hotel"],
];

const CATEGORY_LABELS: Record<NodeCategory, string> = {
  CULTURE: "Landmark",
  NATURE: "Park",
  LEISURE: "Local spot",
  DINING: "Place to eat",
  TRANSIT: "Transit stop",
  ACCOMMODATION: "Hotel",
};

export function kindLabel(kind: string, category: NodeCategory): string {
  return KIND_LABELS.find(([re]) => re.test(kind))?.[1] ?? CATEGORY_LABELS[category];
}

/**
 * Picks the traveller-facing title. `generic` is true when no readable name
 * exists and the title only says what the place is.
 */
export function englishTitle(p: { name: string; nameEn?: string; kind: string; category: NodeCategory }): { title: string; native?: string; generic: boolean } {
  const native = p.name && p.name !== p.nameEn ? p.name : undefined;
  if (p.nameEn && isReadableLatin(p.nameEn)) return { title: p.nameEn, native: native && !isReadableLatin(native) ? native : undefined, generic: false };
  if (isReadableLatin(p.name)) return { title: p.name, generic: false };
  return { title: kindLabel(p.kind, p.category), native: p.name || undefined, generic: true };
}
