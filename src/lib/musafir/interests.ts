/**
 * Traveller interests (pure). A fixed vocabulary the UI shows as chips, the LLM
 * may choose from (never invent), and the planner scores against real OSM
 * kinds/names. Also the deterministic fallback that reads a free-text brief
 * when no LLM is available: keyword grammar only, no guessing beyond it.
 */
/** Mirrors the four VibeConfig faders; declared here so schemas.ts can import this file without a cycle. */
type Faders = { pacing: number; budget: number; culturalDepth: number; circadian: number };

export const INTERESTS = [
  "history",
  "museums",
  "art",
  "architecture",
  "spiritual",
  "nature",
  "beaches",
  "viewpoints",
  "food",
  "street-food",
  "cafes",
  "nightlife",
  "shopping",
  "markets",
  "adventure",
  "wellness",
  "family",
] as const;
export type Interest = (typeof INTERESTS)[number];

export const PARTIES = ["solo", "couple", "family", "friends", "group"] as const;
export type Party = (typeof PARTIES)[number];

/** How each interest shows up in OSM data: main tag ("key=value") and/or name. */
const MATCHERS: Record<Interest, { kind?: RegExp; name?: RegExp }> = {
  history: { kind: /^historic=|^tourism=attraction/, name: /\b(fort|palace|castle|ruins?|tomb|old town|mahal|qila|haveli)\b/i },
  museums: { kind: /^tourism=museum/, name: /\bmuseum\b/i },
  art: { kind: /^(tourism=gallery|amenity=arts_centre|amenity=theatre)/, name: /\b(gallery|art|theatre|theater)\b/i },
  architecture: { kind: /^(historic=(palace|castle|monument)|tourism=attraction)/, name: /\b(cathedral|palace|tower|mahal|gate|bridge|stepwell|baori)\b/i },
  spiritual: { kind: /^(amenity=place_of_worship|historic=temple)/, name: /\b(temple|mandir|mosque|masjid|church|cathedral|gurudwara|monastery|shrine|dargah)\b/i },
  nature: { kind: /^(leisure=(park|garden|nature_reserve)|natural=)/, name: /\b(park|garden|lake|forest|reserve|bagh)\b/i },
  beaches: { kind: /^natural=beach/, name: /\bbeach\b/i },
  viewpoints: { kind: /^tourism=viewpoint/, name: /\b(viewpoint|point|hill|peak|lookout)\b/i },
  food: { kind: /^amenity=(restaurant|food_court)/ },
  "street-food": { kind: /^amenity=(fast_food|food_court)/, name: /\b(chaat|dhaba|stall|street)\b/i },
  cafes: { kind: /^amenity=cafe/, name: /\b(cafe|café|coffee)\b/i },
  nightlife: { kind: /^amenity=(bar|pub|nightclub)/, name: /\b(bar|pub|club|lounge)\b/i },
  shopping: { kind: /^shop=/, name: /\b(mall|bazaar|market|emporium)\b/i },
  markets: { kind: /^(amenity=marketplace|shop=)/, name: /\b(bazaar|market|haat|souk)\b/i },
  adventure: { kind: /^leisure=(sports_centre|water_park)|^tourism=theme_park/, name: /\b(trek|safari|rafting|zipline|adventure)\b/i },
  wellness: { kind: /^leisure=(garden|park)|^amenity=spa/, name: /\b(spa|yoga|ayurved)/i },
  family: { kind: /^(tourism=(zoo|theme_park|aquarium)|leisure=(park|water_park))/, name: /\b(zoo|aquarium|science|planetarium|kids)\b/i },
};

export function matchesInterest(interest: Interest, place: { kind: string; name: string }): boolean {
  const m = MATCHERS[interest];
  return (!!m.kind && m.kind.test(place.kind)) || (!!m.name && m.name.test(place.name));
}

/** Interest fit in [-1, 1]: +share of liked interests matched, −1 if anything to avoid matches. */
export function interestFit(place: { kind: string; name: string }, likes: readonly Interest[], avoid: readonly Interest[]): number {
  if (avoid.some((a) => matchesInterest(a, place))) return -1;
  if (likes.length === 0) return 0;
  const hits = likes.filter((l) => matchesInterest(l, place)).length;
  return Math.min(1, hits / Math.min(2, likes.length));
}

export interface BriefReading {
  vibe: Partial<Faders>;
  interests: Interest[];
  avoid: Interest[];
  party?: Party;
}

const WORDS: Record<Interest, RegExp> = {
  history: /\b(history|historic|heritage|forts?|palaces?|ancient)\b/i,
  museums: /\bmuseums?\b/i,
  art: /\b(art|arts|galler(y|ies)|theatre|theater)\b/i,
  architecture: /\barchitecture\b/i,
  spiritual: /\b(spiritual|temples?|religious|pilgrim\w*|mosques?|churches?)\b/i,
  nature: /\b(nature|parks?|gardens?|hik(e|ing)|lakes?|mountains?|outdoors?)\b/i,
  beaches: /\bbeach(es)?\b/i,
  viewpoints: /\b(views?|viewpoints?|sunsets?|sunrise|scenic)\b/i,
  food: /\b(food|foodie|cuisine|restaurants?|dining)\b/i,
  "street-food": /\bstreet[- ]?food\b/i,
  cafes: /\b(caf(e|é)s?|coffee)\b/i,
  nightlife: /\b(nightlife|bars?|pubs?|clubs?|clubbing|party|parties)\b/i,
  shopping: /\b(shopping|shops?|malls?|souvenirs?)\b/i,
  markets: /\b(markets?|bazaars?)\b/i,
  adventure: /\b(adventure|trek\w*|rafting|safari|thrill\w*)\b/i,
  wellness: /\b(relax\w*|wellness|spa|yoga|ayurved\w*|peaceful|calm)\b/i,
  family: /\b(kids?|children|family)\b/i,
};

/**
 * Keyword reading of a brief (the no-LLM fallback). Only sets what the text
 * clearly says; everything else is left to the faders.
 */
export function readBrief(text: string): BriefReading {
  const t = text.slice(0, 600);
  const vibe: BriefReading["vibe"] = {};
  if (/\b(relax\w*|slow|chill|laid[- ]back|unhurried|lazy)\b/i.test(t)) vibe.pacing = 0.2;
  if (/\b(packed|fast|see (it )?all|as much as possible|busy|action[- ]packed)\b/i.test(t)) vibe.pacing = 0.85;
  if (/\b(budget|cheap|backpack\w*|affordable|low[- ]cost)\b/i.test(t)) vibe.budget = 0.15;
  if (/\b(luxur\w*|splurge|fine dining|premium|five[- ]star|treat)\b/i.test(t)) vibe.budget = 0.9;
  if (/\b(off the beaten|hidden gems?|local|offbeat|authentic|underground)\b/i.test(t)) vibe.culturalDepth = 0.85;
  if (/\b(iconic|must[- ]see|famous|landmarks?|highlights)\b/i.test(t)) vibe.culturalDepth = 0.15;
  if (/\b(early (risers?|mornings?|starts?)|sunrise|morning (person|people))\b/i.test(t)) vibe.circadian = 0.1;
  if (/\b(night owls?|late nights?|sleep in|late starts?)\b/i.test(t)) vibe.circadian = 0.85;

  const interests: Interest[] = [];
  const avoid: Interest[] = [];
  for (const i of INTERESTS) {
    const re = WORDS[i];
    const m = re.exec(t);
    if (!m) continue;
    // "no nightlife", "not into museums", "avoid crowds of shopping" → avoid.
    const before = t.slice(Math.max(0, m.index - 24), m.index);
    (/\b(no|not|avoid|skip|without|hate|don'?t)\b[^.,;]*$/i.test(before) ? avoid : interests).push(i);
  }
  const party: Party | undefined = /\b(solo|alone|by myself)\b/i.test(t)
    ? "solo"
    : /\b(wife|husband|partner|girlfriend|boyfriend|honeymoon|couple)\b/i.test(t)
      ? "couple"
      : /\b(kids?|children|family|parents)\b/i.test(t)
        ? "family"
        : /\b(friends|buddies|mates)\b/i.test(t)
          ? "friends"
          : /\b(group|team|colleagues|office)\b/i.test(t)
            ? "group"
            : undefined;
  return { vibe, interests: interests.slice(0, 6), avoid: avoid.slice(0, 4), party };
}
